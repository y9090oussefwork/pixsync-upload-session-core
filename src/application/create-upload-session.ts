import { AppError, ErrorCode } from "../domain/errors.js";
import type {
  UploadFileRequest,
  UploadSession,
  UploadSessionFile,
} from "../domain/types.js";
import type {
  Clock,
  GalleryRepository,
  IdGenerator,
  SaveSessionResult,
  TenantStorageAccountRepository,
  UploadSessionRepository,
} from "./ports.js";
import {
  SESSION_TTL_MS,
  canonicalFingerprint,
  totalRequestedBytes,
  validateCreateCommand,
  validateFileName,
} from "./validation.js";

export interface CreateUploadSessionCommand {
  tenantId: string;
  providerId: string;
  galleryId: string;
  idempotencyKey: string;
  files: UploadFileRequest[];
}

export interface CreateUploadSessionDeps {
  galleries: GalleryRepository;
  accounts: TenantStorageAccountRepository;
  sessions: UploadSessionRepository;
  ids: IdGenerator;
  clock: Clock;
}

export class CreateUploadSession {
  constructor(private readonly deps: CreateUploadSessionDeps) {}

  async execute(
    command: CreateUploadSessionCommand,
  ): Promise<UploadSession> {
    validateCreateCommand(command);

    const gallery = await this.deps.galleries.findById(command.galleryId);
    // Missing, cross-tenant, and cross-provider galleries all produce the
    // identical error so callers cannot probe gallery existence.
    if (
      !gallery ||
      gallery.tenantId !== command.tenantId ||
      gallery.providerId !== command.providerId
    ) {
      throw new AppError(ErrorCode.GalleryNotFound, "Gallery not found.");
    }
    if (gallery.status !== "ACTIVE") {
      throw new AppError(ErrorCode.GalleryLocked, "Gallery is locked.");
    }

    const fingerprint = canonicalFingerprint(command);
    const existing = await this.deps.sessions.findByIdempotencyKey(
      command.tenantId,
      command.idempotencyKey,
    );
    if (existing) {
      return this.replayOrConflict(existing, fingerprint);
    }

    const totalBytes = totalRequestedBytes(command.files);
    const reservation = await this.deps.accounts.reserveBytes(
      command.tenantId,
      totalBytes,
    );
    if (reservation.kind === "quota-exceeded") {
      throw new AppError(
        ErrorCode.QuotaExceeded,
        "Tenant storage quota exceeded.",
      );
    }
    if (reservation.kind === "tenant-not-found") {
      throw new AppError(
        ErrorCode.TenantNotFound,
        "Tenant storage account not found.",
      );
    }

    const session = this.buildSession(command, fingerprint, totalBytes);

    let saved: SaveSessionResult;
    try {
      saved = await this.deps.sessions.saveIfAbsent(session);
    } catch (error) {
      // Failure atomicity: never leave a reservation without a session.
      await this.deps.accounts.releaseBytes(command.tenantId, totalBytes);
      if (error instanceof AppError) throw error;
      throw new AppError(
        ErrorCode.PersistenceFailure,
        "Upload session could not be persisted.",
      );
    }

    if (saved.kind === "exists") {
      // A concurrent identical request won the unique-key insert; undo our
      // redundant reservation, then replay-or-conflict against the winner.
      await this.deps.accounts.releaseBytes(command.tenantId, totalBytes);
      return this.replayOrConflict(saved.session, fingerprint);
    }
    return session;
  }

  private replayOrConflict(
    existing: UploadSession,
    fingerprint: string,
  ): UploadSession {
    if (existing.fingerprint !== fingerprint) {
      throw new AppError(
        ErrorCode.IdempotencyConflict,
        "Idempotency key was already used with a different request.",
      );
    }
    return existing;
  }

  private buildSession(
    command: CreateUploadSessionCommand,
    fingerprint: string,
    totalBytes: number,
  ): UploadSession {
    const createdAt = this.deps.clock.now();
    const sessionId = this.deps.ids.next();
    const files: UploadSessionFile[] = command.files.map((file) => ({
      ...file,
      objectKey: this.objectKey(command.tenantId, command.galleryId, file.fileName),
    }));
    return {
      id: sessionId,
      tenantId: command.tenantId,
      providerId: command.providerId,
      galleryId: command.galleryId,
      idempotencyKey: command.idempotencyKey,
      fingerprint,
      status: "PENDING",
      reservedBytes: totalBytes,
      createdAt,
      expiresAt: createdAt + SESSION_TTL_MS,
      files,
    };
  }

  /** Server-controlled key layout; the raw filename never reaches the key. */
  private objectKey(
    tenantId: string,
    galleryId: string,
    fileName: string,
  ): string {
    const extension = validateFileName(fileName);
    return `tenants/${tenantId}/galleries/${galleryId}/${this.deps.ids.next()}.${extension}`;
  }
}
