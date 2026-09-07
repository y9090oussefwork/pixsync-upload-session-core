import { describe, expect, it } from "vitest";
import {
  expectAppError,
  makeCommand,
  makeFile,
  makeFiles,
  makeHarness,
  MB,
} from "./helpers.js";

async function createPending(
  h: ReturnType<typeof makeHarness>,
  sizeBytes = 3 * MB,
) {
  return h.core.createUploadSession(
    makeCommand({ files: [makeFile({ sizeBytes })] }),
  );
}

describe("completeUploadSession", () => {
  it("moves reserved bytes to used bytes exactly once", async () => {
    const h = makeHarness();
    const session = await createPending(h);

    const completed = await h.core.completeUploadSession("t-1", session.id, [
      "file-1",
    ]);

    expect(completed.status).toBe("COMPLETED");
    expect(h.accounts.snapshot("t-1")).toMatchObject({
      usedBytes: 3 * MB,
      reservedBytes: 0,
    });
    expect(h.counts.accounts.commitBytes).toBe(1);
  });

  it("repeated completion with the same confirmation set is idempotent", async () => {
    const h = makeHarness();
    const session = await createPending(h);

    const first = await h.core.completeUploadSession("t-1", session.id, [
      "file-1",
    ]);
    const second = await h.core.completeUploadSession("t-1", session.id, [
      "file-1",
    ]);

    expect(second.status).toBe("COMPLETED");
    expect(second.id).toBe(first.id);
    // Quota committed exactly once; used bytes did not double-count.
    expect(h.counts.accounts.commitBytes).toBe(1);
    expect(h.accounts.snapshot("t-1")).toMatchObject({
      usedBytes: 3 * MB,
      reservedBytes: 0,
    });
  });

  it("concurrent completion with the same set commits quota exactly once", async () => {
    const h = makeHarness();
    const session = await createPending(h);

    const [a, b] = await Promise.all([
      h.core.completeUploadSession("t-1", session.id, ["file-1"]),
      h.core.completeUploadSession("t-1", session.id, ["file-1"]),
    ]);

    expect(a.status).toBe("COMPLETED");
    expect(b.status).toBe("COMPLETED");
    expect(h.counts.accounts.commitBytes).toBe(1);
    expect(h.accounts.snapshot("t-1")).toMatchObject({
      usedBytes: 3 * MB,
      reservedBytes: 0,
    });
  });

  it("rejects an incomplete confirmation set and leaves state untouched", async () => {
    const h = makeHarness();
    const session = await h.core.createUploadSession(
      makeCommand({ files: makeFiles(3) }),
    );

    await expectAppError(
      h.core.completeUploadSession("t-1", session.id, ["file-1", "file-2"]),
      "INVALID_UPLOAD",
    );
    const stored = await h.sessions.findById("t-1", session.id);
    expect(stored?.status).toBe("PENDING");
    expect(h.accounts.snapshot("t-1")?.reservedBytes).toBe(3 * MB);
  });

  it("rejects an unknown confirmed file id", async () => {
    const h = makeHarness();
    const session = await createPending(h);
    await expectAppError(
      h.core.completeUploadSession("t-1", session.id, ["file-1", "intruder"]),
      "INVALID_UPLOAD",
    );
  });

  it("rejects duplicate confirmed ids", async () => {
    const h = makeHarness();
    const session = await createPending(h);
    await expectAppError(
      h.core.completeUploadSession("t-1", session.id, ["file-1", "file-1"]),
      "INVALID_UPLOAD",
    );
    expect(h.accounts.snapshot("t-1")?.reservedBytes).toBe(3 * MB);
  });

  it("a cancelled session cannot be completed", async () => {
    const h = makeHarness();
    const session = await createPending(h);
    await h.core.cancelUploadSession("t-1", session.id);

    await expectAppError(
      h.core.completeUploadSession("t-1", session.id, ["file-1"]),
      "INVALID_SESSION_STATE",
    );
    expect(h.accounts.snapshot("t-1")).toMatchObject({
      usedBytes: 0,
      reservedBytes: 0,
    });
  });

  it("cross-tenant completion gets the same error as a missing session", async () => {
    const h = makeHarness();
    const session = await createPending(h);

    const crossTenant = await expectAppError(
      h.core.completeUploadSession("t-2", session.id, ["file-1"]),
      "UPLOAD_SESSION_NOT_FOUND",
    );
    const missing = await expectAppError(
      h.core.completeUploadSession("t-1", "nope", ["file-1"]),
      "UPLOAD_SESSION_NOT_FOUND",
    );
    expect(crossTenant.message).toBe(missing.message);
  });

  it("completes a multi-file session with all confirmations", async () => {
    const h = makeHarness();
    const session = await h.core.createUploadSession(
      makeCommand({ files: makeFiles(4, 2 * MB) }),
    );

    const completed = await h.core.completeUploadSession("t-1", session.id, [
      "file-1",
      "file-2",
      "file-3",
      "file-4",
    ]);

    expect(completed.status).toBe("COMPLETED");
    expect(h.accounts.snapshot("t-1")).toMatchObject({
      usedBytes: 8 * MB,
      reservedBytes: 0,
    });
  });
});
