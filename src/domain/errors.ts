export const ErrorCode = {
  GalleryNotFound: "GALLERY_NOT_FOUND",
  GalleryLocked: "GALLERY_LOCKED",
  InvalidUpload: "INVALID_UPLOAD",
  QuotaExceeded: "QUOTA_EXCEEDED",
  IdempotencyConflict: "IDEMPOTENCY_CONFLICT",
  UploadSessionNotFound: "UPLOAD_SESSION_NOT_FOUND",
  InvalidSessionState: "INVALID_SESSION_STATE",
  PersistenceFailure: "PERSISTENCE_FAILURE",
  TenantNotFound: "TENANT_NOT_FOUND",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Application/domain error with an explicit machine-readable code.
 * Messages are intentionally generic so they never leak tenant-sensitive
 * internal state (e.g. existence of another tenant's gallery).
 */
export class AppError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
  }
}
