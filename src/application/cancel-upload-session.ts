import { AppError, ErrorCode } from "../domain/errors.js";
import type { UploadSession } from "../domain/types.js";
import type {
  TenantStorageAccountRepository,
  UploadSessionRepository,
} from "./ports.js";
import { requireNonEmpty } from "./validation.js";

export interface CancelUploadSessionDeps {
  accounts: TenantStorageAccountRepository;
  sessions: UploadSessionRepository;
}

export class CancelUploadSession {
  constructor(private readonly deps: CancelUploadSessionDeps) {}

  async execute(tenantId: string, sessionId: string): Promise<UploadSession> {
    requireNonEmpty(tenantId, "tenantId");
    requireNonEmpty(sessionId, "sessionId");

    const session = await this.deps.sessions.findById(tenantId, sessionId);
    if (!session) {
      // Same error for "does not exist" and "belongs to another tenant".
      throw new AppError(
        ErrorCode.UploadSessionNotFound,
        "Upload session not found.",
      );
    }
    if (session.status === "CANCELLED") {
      return session; // idempotent replay; quota was already released
    }
    if (session.status === "COMPLETED") {
      throw new AppError(
        ErrorCode.InvalidSessionState,
        "A completed upload session cannot be cancelled.",
      );
    }

    // CAS PENDING -> CANCELLED is the linearization point: exactly one caller
    // wins and therefore exactly one caller releases the reservation.
    const transition = await this.deps.sessions.compareAndSetStatus(
      tenantId,
      sessionId,
      "PENDING",
      "CANCELLED",
    );
    if (transition.kind === "updated") {
      await this.deps.accounts.releaseBytes(tenantId, session.reservedBytes);
      return transition.session;
    }

    const current =
      transition.session ??
      (await this.deps.sessions.findById(tenantId, sessionId));
    if (!current) {
      throw new AppError(
        ErrorCode.UploadSessionNotFound,
        "Upload session not found.",
      );
    }
    if (current.status === "CANCELLED") {
      return current; // lost the race to a concurrent cancel
    }
    throw new AppError(
      ErrorCode.InvalidSessionState,
      "A completed upload session cannot be cancelled.",
    );
  }
}
