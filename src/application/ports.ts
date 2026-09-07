import type {
  Gallery,
  TenantStorageAccount,
  UploadSession,
  UploadSessionStatus,
} from "../domain/types.js";

export interface Clock {
  /** Current time in epoch milliseconds. */
  now(): number;
}

export interface IdGenerator {
  next(): string;
}

export type ReserveOutcome =
  | { kind: "reserved"; account: TenantStorageAccount }
  | { kind: "quota-exceeded" }
  | { kind: "tenant-not-found" };

export type CommitOutcome =
  | { kind: "committed"; account: TenantStorageAccount }
  | { kind: "tenant-not-found" };

/**
 * Quota operations are exposed as single atomic primitives, mirroring what
 * PostgreSQL would do with a conditional UPDATE:
 *
 *   UPDATE tenant_storage_accounts
 *      SET reserved_bytes = reserved_bytes + $amount
 *    WHERE tenant_id = $tenant
 *      AND used_bytes + reserved_bytes + $amount <= limit_bytes;
 *
 * Callers must never read the account, compare in the service, then write —
 * the check and the mutation happen inside one repository operation.
 */
export interface TenantStorageAccountRepository {
  reserveBytes(tenantId: string, amountBytes: number): Promise<ReserveOutcome>;
  releaseBytes(tenantId: string, amountBytes: number): Promise<void>;
  commitBytes(tenantId: string, amountBytes: number): Promise<CommitOutcome>;
}

export interface GalleryRepository {
  findById(galleryId: string): Promise<Gallery | null>;
}

export type SaveSessionResult =
  | { kind: "saved" }
  | { kind: "exists"; session: UploadSession };

export type StatusTransitionResult =
  | { kind: "updated"; session: UploadSession }
  | { kind: "stale"; session: UploadSession | null };

/**
 * Sessions are persisted as whole aggregates (files included) in one call,
 * so there is never a per-file repository round-trip.
 */
export interface UploadSessionRepository {
  findById(tenantId: string, sessionId: string): Promise<UploadSession | null>;
  findByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<UploadSession | null>;
  /** Atomic insert guarded by the (tenantId, idempotencyKey) unique constraint. */
  saveIfAbsent(session: UploadSession): Promise<SaveSessionResult>;
  /** Atomic compare-and-set on status; the linearization point for quota release/commit. */
  compareAndSetStatus(
    tenantId: string,
    sessionId: string,
    expected: UploadSessionStatus,
    next: UploadSessionStatus,
  ): Promise<StatusTransitionResult>;
}
