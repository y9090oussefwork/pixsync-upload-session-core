import { describe, expect, it } from "vitest";
import {
  expectAppError,
  makeCommand,
  makeFile,
  makeHarness,
  MB,
} from "./helpers.js";

async function createPending(h: ReturnType<typeof makeHarness>, sizeBytes = 10 * MB) {
  return h.core.createUploadSession(
    makeCommand({ files: [makeFile({ sizeBytes })] }),
  );
}

describe("cancelUploadSession", () => {
  it("cancels a PENDING session and releases the reserved quota", async () => {
    const h = makeHarness();
    const session = await createPending(h);
    expect(h.accounts.snapshot("t-1")?.reservedBytes).toBe(10 * MB);

    const cancelled = await h.core.cancelUploadSession("t-1", session.id);

    expect(cancelled.status).toBe("CANCELLED");
    expect(h.accounts.snapshot("t-1")?.reservedBytes).toBe(0);
  });

  it("repeated cancellation is idempotent and releases quota exactly once", async () => {
    const h = makeHarness();
    const session = await createPending(h);

    const first = await h.core.cancelUploadSession("t-1", session.id);
    const second = await h.core.cancelUploadSession("t-1", session.id);

    expect(first.status).toBe("CANCELLED");
    expect(second.status).toBe("CANCELLED");
    // Exactly one releaseBytes call reached the repository.
    expect(h.counts.accounts.releaseBytes).toBe(1);
    expect(h.accounts.snapshot("t-1")?.reservedBytes).toBe(0);
  });

  it("concurrent cancellation releases quota exactly once", async () => {
    const h = makeHarness();
    const session = await createPending(h);

    const [a, b] = await Promise.all([
      h.core.cancelUploadSession("t-1", session.id),
      h.core.cancelUploadSession("t-1", session.id),
    ]);

    expect(a.status).toBe("CANCELLED");
    expect(b.status).toBe("CANCELLED");
    expect(h.counts.accounts.releaseBytes).toBe(1);
    expect(h.accounts.snapshot("t-1")?.reservedBytes).toBe(0);
  });

  it("a completed session cannot be cancelled", async () => {
    const h = makeHarness();
    const session = await createPending(h);
    await h.core.completeUploadSession("t-1", session.id, ["file-1"]);

    await expectAppError(
      h.core.cancelUploadSession("t-1", session.id),
      "INVALID_SESSION_STATE",
    );
    // Quota stays committed; nothing was released.
    expect(h.accounts.snapshot("t-1")).toMatchObject({
      usedBytes: 10 * MB,
      reservedBytes: 0,
    });
    expect(h.counts.accounts.releaseBytes ?? 0).toBe(0);
  });

  it("cross-tenant cancellation gets the same error as a missing session", async () => {
    const h = makeHarness();
    const session = await createPending(h);

    const crossTenant = await expectAppError(
      h.core.cancelUploadSession("t-2", session.id),
      "UPLOAD_SESSION_NOT_FOUND",
    );
    const missing = await expectAppError(
      h.core.cancelUploadSession("t-1", "no-such-session"),
      "UPLOAD_SESSION_NOT_FOUND",
    );
    expect(crossTenant.message).toBe(missing.message);
    // The real session and its reservation are untouched.
    expect(h.accounts.snapshot("t-1")?.reservedBytes).toBe(10 * MB);
    expect(h.sessions.count()).toBe(1);
  });

  it("cancelling releases only the session's own reservation", async () => {
    const h = makeHarness();
    const keep = await createPending(h, 20 * MB);
    const drop = await h.core.createUploadSession(
      makeCommand({
        idempotencyKey: "key-2",
        files: [makeFile({ sizeBytes: 30 * MB })],
      }),
    );
    expect(h.accounts.snapshot("t-1")?.reservedBytes).toBe(50 * MB);

    await h.core.cancelUploadSession("t-1", drop.id);

    expect(h.accounts.snapshot("t-1")?.reservedBytes).toBe(20 * MB);
    const stillPending = await h.sessions.findById("t-1", keep.id);
    expect(stillPending?.status).toBe("PENDING");
  });
});
