import { describe, expect, it } from "vitest";
import {
  AppError,
  InMemoryUploadSessionRepository,
  type SaveSessionResult,
  type UploadSession,
} from "../src/index.js";
import {
  expectAppError,
  makeCommand,
  makeFile,
  makeHarness,
  MB,
} from "./helpers.js";

/** Simulates a database outage on session insert. */
class FailingUploadSessionRepository extends InMemoryUploadSessionRepository {
  override async saveIfAbsent(
    _session: UploadSession,
  ): Promise<SaveSessionResult> {
    throw new Error("simulated database outage");
  }
}

describe("quota enforcement", () => {
  it("rejects a request that exceeds the remaining quota", async () => {
    const h = makeHarness();
    await expectAppError(
      h.core.createUploadSession(
        makeCommand({ files: [makeFile({ sizeBytes: 101 * MB })] }),
      ),
      "QUOTA_EXCEEDED",
    );
    expect(h.accounts.snapshot("t-1")?.reservedBytes).toBe(0);
    expect(h.sessions.count()).toBe(0);
  });

  it("counts used bytes against the limit and allows an exact fit", async () => {
    const h = makeHarness({
      accountSeed: [
        { tenantId: "t-1", limitBytes: 100 * MB, usedBytes: 60 * MB, reservedBytes: 0 },
      ],
    });
    await expectAppError(
      h.core.createUploadSession(
        makeCommand({ files: [makeFile({ sizeBytes: 40 * MB + 1 })] }),
      ),
      "QUOTA_EXCEEDED",
    );
    const exact = await h.core.createUploadSession(
      makeCommand({
        idempotencyKey: "key-2",
        files: [makeFile({ sizeBytes: 40 * MB })],
      }),
    );
    expect(exact.status).toBe("PENDING");
    const account = h.accounts.snapshot("t-1");
    expect(account!.usedBytes + account!.reservedBytes).toBe(100 * MB);
  });

  it("rejects when a tenant has no storage account", async () => {
    const h = makeHarness({
      gallerySeed: [
        { id: "g-1", tenantId: "t-1", providerId: "p-1", status: "ACTIVE" },
        { id: "g-ghost", tenantId: "t-ghost", providerId: "p-1", status: "ACTIVE" },
      ],
    });
    await expectAppError(
      h.core.createUploadSession(
        makeCommand({
          tenantId: "t-ghost",
          galleryId: "g-ghost",
          files: [makeFile()],
        }),
      ),
      "TENANT_NOT_FOUND",
    );
    expect(h.sessions.count()).toBe(0);
  });

  it("concurrent requests that cannot both fit: exactly one succeeds", async () => {
    const h = makeHarness();
    const requestA = h.core.createUploadSession(
      makeCommand({
        idempotencyKey: "req-a",
        files: [makeFile({ sizeBytes: 80 * MB })],
      }),
    );
    const requestB = h.core.createUploadSession(
      makeCommand({
        idempotencyKey: "req-b",
        files: [makeFile({ sizeBytes: 80 * MB })],
      }),
    );

    const results = await Promise.allSettled([requestA, requestB]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof AppError,
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult & { reason: AppError }).reason.code).toBe(
      "QUOTA_EXCEEDED",
    );

    // Quota invariant holds and exactly one reservation exists.
    const account = h.accounts.snapshot("t-1");
    expect(account?.reservedBytes).toBe(80 * MB);
    expect(account!.usedBytes + account!.reservedBytes).toBeLessThanOrEqual(
      account!.limitBytes,
    );
    expect(h.sessions.count()).toBe(1);
  });

  it("persistence failure after reservation does not leak reserved quota", async () => {
    const h = makeHarness({ sessions: new FailingUploadSessionRepository() });
    await expectAppError(
      h.core.createUploadSession(
        makeCommand({ files: [makeFile({ sizeBytes: 30 * MB })] }),
      ),
      "PERSISTENCE_FAILURE",
    );
    expect(h.accounts.snapshot("t-1")?.reservedBytes).toBe(0);
    expect(h.sessions.count()).toBe(0);
  });

  it("the quota invariant survives a mixed concurrent workload", async () => {
    const h = makeHarness();
    const requests = Array.from({ length: 12 }, (_, index) =>
      h.core.createUploadSession(
        makeCommand({
          idempotencyKey: `burst-${index}`,
          files: [makeFile({ sizeBytes: 15 * MB })],
        }),
      ),
    );

    const results = await Promise.allSettled(requests);
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected").length;

    // 100 MB / 15 MB => at most 6 reservations can exist at once.
    expect(succeeded).toBe(6);
    expect(failed).toBe(6);
    const account = h.accounts.snapshot("t-1");
    expect(account!.usedBytes + account!.reservedBytes).toBeLessThanOrEqual(
      account!.limitBytes,
    );
    expect(account?.reservedBytes).toBe(90 * MB);
  });
});
