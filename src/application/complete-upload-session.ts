import { AppError, ErrorCode } from "../domain/errors.js";
import type { UploadSession } from "../domain/types.js";
import type {
  TenantStorageAccountRepository,
  UploadSessionRepository,
} from "./ports.js";
import { invalidUpload, requireNonEmpty } from "./validation.js";

export interface CompleteUploadSessionDeps {
  accounts: TenantStorageAccountRepository;
  sessions: UploadSessionRepository;
}

export class CompleteUploadSession {
  constructor(private readonly deps: CompleteUploadSessionDeps) {}

  async execute(
    tenantId: string,
    sessionId: string,
    confirmedClientFileIds: readonly string[],
  ): Promise<UploadSession> {
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

    // Confirmation-set validation runs before the status check, so an
    // idempotent replay of an already-completed session must carry the exact
    // same confirmed file set.
    this.validateConfirmation(session, confirmedClientFileIds);

    if (session.status === "COMPLETED") {
      return session; // idempotent replay; quota was already committed
    }
    if (session.status === "CANCELLED") {
      throw new AppError(
        ErrorCode.InvalidSessionState,
        "A cancelled upload session cannot be completed.",
      );
    }

    // CAS PENDING -> COMPLETED is the linearization point: exactly one caller
    // wins and therefore exactly one caller commits the reservation.
    const transition = await this.deps.sessions.compareAndSetStatus(
      tenantId,
      sessionId,
      "PENDING",
      "COMPLETED",
    );
    if (transition.kind === "updated") {
      const commit = await this.deps.accounts.commitBytes(
        tenantId,
        session.reservedBytes,
      );
      if (commit.kind !== "committed") {
        throw new Error(
          "Invariant violation: quota commit failed after session transition.",
        );
      }
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
    if (current.status === "COMPLETED") {
      return current; // lost the race to a concurrent completion
    }
    throw new AppError(
      ErrorCode.InvalidSessionState,
      "A cancelled upload session cannot be completed.",
    );
  }

  private validateConfirmation(
    session: UploadSession,
    confirmed: readonly string[],
  ): void {
    if (!Array.isArray(confirmed)) {
      invalidUpload("confirmedClientFileIds must be an array");
    }
    const expected = new Set(session.files.map((file) => file.clientFileId));
    const seen = new Set<string>();
    for (const clientFileId of confirmed) {
      if (typeof clientFileId !== "string" || clientFileId === "") {
        invalidUpload("confirmed clientFileIds must be non-empty strings");
      }
      if (seen.has(clientFileId)) {
        invalidUpload(`duplicate confirmed clientFileId "${clientFileId}"`);
      }
      seen.add(clientFileId);
      if (!expected.has(clientFileId)) {
        invalidUpload(`unknown clientFileId in confirmation "${clientFileId}"`);
      }
    }
    for (const clientFileId of expected) {
      if (!seen.has(clientFileId)) {
        invalidUpload(`missing confirmation for clientFileId "${clientFileId}"`);
      }
    }
  }
}
