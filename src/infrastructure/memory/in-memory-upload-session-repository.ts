import type {
  UploadSession,
  UploadSessionStatus,
} from "../../domain/types.js";
import type {
  SaveSessionResult,
  StatusTransitionResult,
  UploadSessionRepository,
} from "../../application/ports.js";
import { clone, tick } from "./utils.js";

/**
 * Sessions are stored as whole aggregates, so a 50-file session is one
 * insert — never one write per file. The idempotency index mirrors a
 * PostgreSQL UNIQUE (tenant_id, idempotency_key) constraint.
 */
export class InMemoryUploadSessionRepository
  implements UploadSessionRepository
{
  private readonly byId = new Map<string, UploadSession>();
  private readonly idByKey = new Map<string, string>();

  async findById(
    tenantId: string,
    sessionId: string,
  ): Promise<UploadSession | null> {
    await tick();
    const session = this.byId.get(sessionId);
    if (!session || session.tenantId !== tenantId) {
      return null;
    }
    return clone(session);
  }

  async findByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<UploadSession | null> {
    await tick();
    const sessionId = this.idByKey.get(this.key(tenantId, idempotencyKey));
    const session =
      sessionId === undefined ? undefined : this.byId.get(sessionId);
    return session ? clone(session) : null;
  }

  async saveIfAbsent(session: UploadSession): Promise<SaveSessionResult> {
    await tick();
    const key = this.key(session.tenantId, session.idempotencyKey);
    const existingId = this.idByKey.get(key);
    if (existingId !== undefined) {
      const existing = this.byId.get(existingId);
      if (existing) {
        return { kind: "exists", session: clone(existing) };
      }
    }
    const stored = clone(session);
    this.byId.set(stored.id, stored);
    this.idByKey.set(key, stored.id);
    return { kind: "saved" };
  }

  async compareAndSetStatus(
    tenantId: string,
    sessionId: string,
    expected: UploadSessionStatus,
    next: UploadSessionStatus,
  ): Promise<StatusTransitionResult> {
    await tick();
    const session = this.byId.get(sessionId);
    if (!session || session.tenantId !== tenantId) {
      return { kind: "stale", session: null };
    }
    if (session.status !== expected) {
      return { kind: "stale", session: clone(session) };
    }
    session.status = next;
    return { kind: "updated", session: clone(session) };
  }

  /** Test helper: number of stored sessions. Not part of the port. */
  count(): number {
    return this.byId.size;
  }

  private key(tenantId: string, idempotencyKey: string): string {
    // JSON pair encoding keeps composite keys collision-free for any strings.
    return JSON.stringify([tenantId, idempotencyKey]);
  }
}
