export type GalleryStatus = "ACTIVE" | "LOCKED";

export interface Gallery {
  id: string;
  tenantId: string;
  providerId: string;
  status: GalleryStatus;
}

export interface TenantStorageAccount {
  tenantId: string;
  limitBytes: number;
  usedBytes: number;
  reservedBytes: number;
}

export type UploadSessionStatus = "PENDING" | "COMPLETED" | "CANCELLED";

export interface UploadFileRequest {
  clientFileId: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
}

export interface UploadSessionFile extends UploadFileRequest {
  /** Server-generated object storage key; never derived from the raw filename. */
  objectKey: string;
}

export interface UploadSession {
  id: string;
  tenantId: string;
  providerId: string;
  galleryId: string;
  idempotencyKey: string;
  /** SHA-256 over the canonical request payload; used for idempotent replay vs. conflict. */
  fingerprint: string;
  status: UploadSessionStatus;
  reservedBytes: number;
  createdAt: number;
  expiresAt: number;
  files: UploadSessionFile[];
}
