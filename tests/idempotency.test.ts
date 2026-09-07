import { describe, expect, it } from "vitest";
import type { UploadFileRequest } from "../src/index.js";
import {
  expectAppError,
  makeCommand,
  makeFile,
  makeHarness,
  MB,
  VALID_SHA,
} from "./helpers.js";

describe("idempotency", () => {
  it("replaying the identical request returns the original session without reserving again", async () => {
    const h = makeHarness();
    const command = makeCommand({
      files: [makeFile({ sizeBytes: 10 * MB })],
    });

    const first = await h.core.createUploadSession(command);
    const replay = await h.core.createUploadSession(command);

    expect(replay).toEqual(first);
    expect(h.sessions.count()).toBe(1);
    // Quota reserved exactly once.
    expect(h.accounts.snapshot("t-1")?.reservedBytes).toBe(10 * MB);
    // No new ids were generated for the replay (session id + one file key).
    expect(h.ids.next()).toBe("gen-3");
  });

  it("canonical comparison ignores property and file ordering", async () => {
    const h = makeHarness();
    const original = await h.core.createUploadSession(
      makeCommand({
        files: [
          makeFile({ clientFileId: "a", fileName: "a.jpg", sizeBytes: 2 * MB }),
          makeFile({ clientFileId: "b", fileName: "b.png", sizeBytes: 3 * MB }),
        ],
      }),
    );

    // Same logical payload, different key insertion order and file order.
    const shuffledFile: UploadFileRequest = {
      sha256: VALID_SHA,
      sizeBytes: 3 * MB,
      fileName: "b.png",
      clientFileId: "b",
    };
    const replay = await h.core.createUploadSession({
      files: [shuffledFile, makeFile({ clientFileId: "a", fileName: "a.jpg", sizeBytes: 2 * MB })],
      idempotencyKey: "key-1",
      galleryId: "g-1",
      providerId: "p-1",
      tenantId: "t-1",
    });

    expect(replay).toEqual(original);
    expect(h.accounts.snapshot("t-1")?.reservedBytes).toBe(5 * MB);
  });

  it("reusing the key with a different payload raises IDEMPOTENCY_CONFLICT", async () => {
    const h = makeHarness();
    const original = await h.core.createUploadSession(
      makeCommand({ files: [makeFile({ sizeBytes: 10 * MB })] }),
    );

    await expectAppError(
      h.core.createUploadSession(
        makeCommand({ files: [makeFile({ sizeBytes: 11 * MB })] }),
      ),
      "IDEMPOTENCY_CONFLICT",
    );

    // Original session and quota are untouched; nothing new was stored.
    const stored = await h.sessions.findById("t-1", original.id);
    expect(stored).toEqual(original);
    expect(h.sessions.count()).toBe(1);
    expect(h.accounts.snapshot("t-1")?.reservedBytes).toBe(10 * MB);
  });

  it("a different tenant may reuse the same idempotency key", async () => {
    const h = makeHarness({
      gallerySeed: [
        { id: "g-1", tenantId: "t-1", providerId: "p-1", status: "ACTIVE" },
        { id: "g-2", tenantId: "t-2", providerId: "p-1", status: "ACTIVE" },
      ],
    });

    const sessionA = await h.core.createUploadSession(
      makeCommand({ files: [makeFile({ sizeBytes: 7 * MB })] }),
    );
    const sessionB = await h.core.createUploadSession(
      makeCommand({
        tenantId: "t-2",
        galleryId: "g-2",
        files: [makeFile({ sizeBytes: 9 * MB })],
      }),
    );

    expect(sessionA.id).not.toBe(sessionB.id);
    expect(h.sessions.count()).toBe(2);
    expect(h.accounts.snapshot("t-1")?.reservedBytes).toBe(7 * MB);
    expect(h.accounts.snapshot("t-2")?.reservedBytes).toBe(9 * MB);
  });

  it("two concurrent identical requests produce one session and one reservation", async () => {
    const h = makeHarness();
    const command = makeCommand({
      files: [makeFile({ sizeBytes: 10 * MB })],
    });

    const [a, b] = await Promise.all([
      h.core.createUploadSession(command),
      h.core.createUploadSession(command),
    ]);

    expect(a).toEqual(b);
    expect(h.sessions.count()).toBe(1);
    // The loser released its redundant reservation.
    expect(h.accounts.snapshot("t-1")?.reservedBytes).toBe(10 * MB);
  });

  it("a cancelled session can be replayed by idempotency key", async () => {
    const h = makeHarness();
    const command = makeCommand({ files: [makeFile({ sizeBytes: 4 * MB })] });
    const first = await h.core.createUploadSession(command);
    await h.core.cancelUploadSession("t-1", first.id);

    const replay = await h.core.createUploadSession(command);
    expect(replay.id).toBe(first.id);
    expect(replay.status).toBe("CANCELLED");
    expect(h.sessions.count()).toBe(1);
    expect(h.accounts.snapshot("t-1")?.reservedBytes).toBe(0);
  });
});
