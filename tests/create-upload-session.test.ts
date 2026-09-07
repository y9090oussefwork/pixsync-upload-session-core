import { describe, expect, it } from "vitest";
import { MAX_FILE_BYTES } from "../src/index.js";
import {
  expectAppError,
  grabError,
  makeCommand,
  makeFile,
  makeFiles,
  makeHarness,
  MB,
} from "./helpers.js";

describe("createUploadSession — happy path", () => {
  it("creates a valid session with server-generated object keys", async () => {
    const h = makeHarness();
    const session = await h.core.createUploadSession(
      makeCommand({
        files: [
          makeFile({ fileName: "Sunset.JPG" }),
          makeFile({ clientFileId: "file-2", fileName: "pic.webp", sizeBytes: 2 * MB }),
        ],
      }),
    );

    expect(session.status).toBe("PENDING");
    expect(session.tenantId).toBe("t-1");
    expect(session.providerId).toBe("p-1");
    expect(session.galleryId).toBe("g-1");
    expect(session.idempotencyKey).toBe("key-1");
    expect(session.reservedBytes).toBe(3 * MB);
    expect(session.id).toBe("gen-1");

    // Deterministic injected ids: session id first, then one per file.
    expect(session.files[0].objectKey).toBe(
      "tenants/t-1/galleries/g-1/gen-2.jpg",
    );
    expect(session.files[1].objectKey).toBe(
      "tenants/t-1/galleries/g-1/gen-3.webp",
    );
    // The raw filename never appears in the storage key.
    expect(session.files[0].objectKey).not.toContain("Sunset");
    // Original display name is preserved on the file record.
    expect(session.files[0].fileName).toBe("Sunset.JPG");
  });

  it("expires sessions exactly 15 minutes after creation (injected clock)", async () => {
    const h = makeHarness();
    const session = await h.core.createUploadSession(makeCommand());
    expect(session.createdAt).toBe(h.clock.now());
    expect(session.expiresAt - session.createdAt).toBe(15 * 60 * 1000);

    h.clock.set(1_700_000_999_000);
    const later = await h.core.createUploadSession(
      makeCommand({ idempotencyKey: "key-2" }),
    );
    expect(later.createdAt).toBe(1_700_000_999_000);
    expect(later.expiresAt).toBe(1_700_000_999_000 + 15 * 60 * 1000);
  });

  it("accepts every whitelisted extension, case-insensitively", async () => {
    const h = makeHarness();
    const session = await h.core.createUploadSession(
      makeCommand({
        files: [
          makeFile({ clientFileId: "a", fileName: "x.jpg" }),
          makeFile({ clientFileId: "b", fileName: "x.JPEG" }),
          makeFile({ clientFileId: "c", fileName: "x.PnG" }),
          makeFile({ clientFileId: "d", fileName: "x.WebP" }),
          makeFile({ clientFileId: "e", fileName: "x.HEIC" }),
        ],
      }),
    );
    expect(session.files.map((f) => f.objectKey.split(".").pop())).toEqual([
      "jpg",
      "jpeg",
      "png",
      "webp",
      "heic",
    ]);
  });
});

describe("createUploadSession — gallery access", () => {
  it("rejects another tenant's gallery with the same error as a missing gallery", async () => {
    const h = makeHarness();
    const crossTenant = await expectAppError(
      h.core.createUploadSession(makeCommand({ galleryId: "g-other-tenant" })),
      "GALLERY_NOT_FOUND",
    );
    const missing = await expectAppError(
      h.core.createUploadSession(makeCommand({ galleryId: "nope" })),
      "GALLERY_NOT_FOUND",
    );
    // Identical code AND message: existence of foreign galleries is not leaked.
    expect(crossTenant.message).toBe(missing.message);
  });

  it("rejects a gallery from another provider with the same not-found error", async () => {
    const h = makeHarness();
    const crossProvider = await expectAppError(
      h.core.createUploadSession(makeCommand({ galleryId: "g-other-provider" })),
      "GALLERY_NOT_FOUND",
    );
    const missing = await expectAppError(
      h.core.createUploadSession(makeCommand({ galleryId: "nope" })),
      "GALLERY_NOT_FOUND",
    );
    expect(crossProvider.message).toBe(missing.message);
  });

  it("rejects a locked gallery", async () => {
    const h = makeHarness();
    await expectAppError(
      h.core.createUploadSession(makeCommand({ galleryId: "g-locked" })),
      "GALLERY_LOCKED",
    );
    expect(h.accounts.snapshot("t-1")?.reservedBytes).toBe(0);
  });
});

describe("createUploadSession — file validation", () => {
  it("rejects an empty file list", async () => {
    const h = makeHarness();
    await expectAppError(
      h.core.createUploadSession(makeCommand({ files: [] })),
      "INVALID_UPLOAD",
    );
  });

  it("rejects more than 50 files", async () => {
    const h = makeHarness();
    await expectAppError(
      h.core.createUploadSession(makeCommand({ files: makeFiles(51) })),
      "INVALID_UPLOAD",
    );
  });

  it("rejects duplicate clientFileIds", async () => {
    const h = makeHarness();
    await expectAppError(
      h.core.createUploadSession(
        makeCommand({
          files: [
            makeFile({ clientFileId: "same" }),
            makeFile({ clientFileId: "same", fileName: "other.png" }),
          ],
        }),
      ),
      "INVALID_UPLOAD",
    );
  });

  const badFiles: Array<[string, Partial<ReturnType<typeof makeFile>>]> = [
    ["zero size", { sizeBytes: 0 }],
    ["negative size", { sizeBytes: -5 }],
    ["fractional size", { sizeBytes: 1024.5 }],
    ["size above 2 GiB", { sizeBytes: MAX_FILE_BYTES + 1 }],
    ["uppercase sha256", { sha256: "A".repeat(64) }],
    ["short sha256", { sha256: "a".repeat(63) }],
    ["non-hex sha256", { sha256: "g".repeat(64) }],
    ["disallowed extension", { fileName: "movie.gif" }],
    ["missing extension", { fileName: "README" }],
    ["path traversal", { fileName: "../../etc/passwd.jpg" }],
    ["embedded traversal", { fileName: "a/../b.jpg" }],
    ["forward slash", { fileName: "dir/photo.jpg" }],
    ["backslash", { fileName: "dir\\photo.jpg" }],
    ["control character", { fileName: "evil\x00.jpg" }],
    ["newline in name", { fileName: "evil\n.jpg" }],
    ["empty file name", { fileName: "   " }],
    ["empty clientFileId", { clientFileId: "" }],
  ];

  for (const [label, overrides] of badFiles) {
    it(`rejects a file with ${label}`, async () => {
      const h = makeHarness();
      await expectAppError(
        h.core.createUploadSession(makeCommand({ files: [makeFile(overrides)] })),
        "INVALID_UPLOAD",
      );
      expect(h.accounts.snapshot("t-1")?.reservedBytes).toBe(0);
    });
  }

  it("accepts a file of exactly 2 GiB", async () => {
    const h = makeHarness({
      accountSeed: [
        { tenantId: "t-1", limitBytes: 3 * MAX_FILE_BYTES, usedBytes: 0, reservedBytes: 0 },
      ],
    });
    const session = await h.core.createUploadSession(
      makeCommand({ files: [makeFile({ sizeBytes: MAX_FILE_BYTES })] }),
    );
    expect(session.reservedBytes).toBe(MAX_FILE_BYTES);
  });

  it("rejects an invalid request before touching the repositories", async () => {
    const h = makeHarness();
    const error = await grabError(
      h.core.createUploadSession(makeCommand({ files: [] })),
    );
    expect(error).toBeInstanceOf(Error);
    expect(h.counts.galleries.findById ?? 0).toBe(0);
    expect(h.counts.accounts.reserveBytes ?? 0).toBe(0);
  });
});
