import { describe, expect, it } from "vitest";
import {
  makeCommand,
  makeFiles,
  makeHarness,
  MB,
} from "./helpers.js";

describe("batch repository behavior (no N+1)", () => {
  it("creating a 50-file session uses one call per aggregate operation", async () => {
    const h = makeHarness();
    const session = await h.core.createUploadSession(
      makeCommand({ files: makeFiles(50, 1 * MB) }),
    );

    expect(session.files).toHaveLength(50);
    expect(new Set(session.files.map((f) => f.objectKey)).size).toBe(50);
    expect(h.accounts.snapshot("t-1")?.reservedBytes).toBe(50 * MB);

    // Exactly one repository call per logical operation — never per file.
    expect(h.counts.galleries.findById).toBe(1);
    expect(h.counts.accounts.reserveBytes).toBe(1);
    expect(h.counts.sessions.findByIdempotencyKey).toBe(1);
    expect(h.counts.sessions.saveIfAbsent).toBe(1);
    expect(h.counts.sessions.findById ?? 0).toBe(0);
    expect(h.counts.sessions.compareAndSetStatus ?? 0).toBe(0);

    const totalSessionCalls = Object.values(h.counts.sessions).reduce(
      (sum, n) => sum + n,
      0,
    );
    expect(totalSessionCalls).toBe(2);
  });

  it("completing a 50-file session also avoids per-file repository calls", async () => {
    const h = makeHarness();
    const session = await h.core.createUploadSession(
      makeCommand({ files: makeFiles(50, 1 * MB) }),
    );
    const before = { ...h.counts.sessions };

    await h.core.completeUploadSession(
      "t-1",
      session.id,
      session.files.map((f) => f.clientFileId),
    );

    expect(h.counts.sessions.findById - (before.findById ?? 0)).toBe(1);
    expect(h.counts.sessions.compareAndSetStatus - (before.compareAndSetStatus ?? 0)).toBe(1);
    expect(h.counts.accounts.commitBytes).toBe(1);
    expect(h.counts.accounts.releaseBytes ?? 0).toBe(0);
  });
});
