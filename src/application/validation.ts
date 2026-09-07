import { createHash } from "node:crypto";
import { AppError, ErrorCode } from "../domain/errors.js";
import type { UploadFileRequest } from "../domain/types.js";

export const MIN_FILES = 1;
export const MAX_FILES = 50;
export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
export const SESSION_TTL_MS = 15 * 60 * 1000; // sessions expire exactly 15 min after creation

const ALLOWED_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "heic"]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

export function invalidUpload(reason: string): never {
  throw new AppError(ErrorCode.InvalidUpload, reason);
}

export function requireNonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    invalidUpload(`${field} must be a non-empty string`);
  }
  return value;
}

/**
 * Validates filename safety and returns the normalized (lowercased) extension.
 * Throws INVALID_UPLOAD on path traversal, directory separators, control
 * characters, or a non-whitelisted extension.
 */
export function validateFileName(fileName: string): string {
  requireNonEmpty(fileName, "fileName");
  if (CONTROL_CHARS.test(fileName)) {
    invalidUpload("fileName must not contain control characters");
  }
  if (fileName.includes("/") || fileName.includes("\\")) {
    invalidUpload("fileName must not contain directory separators");
  }
  if (fileName.includes("..")) {
    invalidUpload("fileName must not contain path traversal");
  }
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) {
    invalidUpload("fileName must include a recognized extension");
  }
  const extension = fileName.slice(dot + 1).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    invalidUpload(`file extension ".${extension}" is not allowed`);
  }
  return extension;
}

export interface CreateUploadCommandInput {
  tenantId: string;
  providerId: string;
  galleryId: string;
  idempotencyKey: string;
  files: UploadFileRequest[];
}

export function validateCreateCommand(command: CreateUploadCommandInput): void {
  requireNonEmpty(command.tenantId, "tenantId");
  requireNonEmpty(command.providerId, "providerId");
  requireNonEmpty(command.galleryId, "galleryId");
  requireNonEmpty(command.idempotencyKey, "idempotencyKey");

  const files = command.files;
  if (
    !Array.isArray(files) ||
    files.length < MIN_FILES ||
    files.length > MAX_FILES
  ) {
    invalidUpload(`files must contain between ${MIN_FILES} and ${MAX_FILES} entries`);
  }

  const seenIds = new Set<string>();
  for (const file of files) {
    requireNonEmpty(file.clientFileId, "clientFileId");
    if (seenIds.has(file.clientFileId)) {
      invalidUpload(`duplicate clientFileId "${file.clientFileId}" in request`);
    }
    seenIds.add(file.clientFileId);

    validateFileName(file.fileName);

    if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes <= 0) {
      invalidUpload("sizeBytes must be a positive integer number of bytes");
    }
    if (file.sizeBytes > MAX_FILE_BYTES) {
      invalidUpload("sizeBytes exceeds the 2 GiB per-file limit");
    }

    if (
      typeof file.sha256 !== "string" ||
      !SHA256_PATTERN.test(file.sha256)
    ) {
      invalidUpload("sha256 must be exactly 64 lowercase hexadecimal characters");
    }
  }
}

export function totalRequestedBytes(
  files: readonly UploadFileRequest[],
): number {
  return files.reduce((sum, file) => sum + file.sizeBytes, 0);
}

/**
 * Canonical fingerprint of the logical request. Built from explicitly ordered
 * object literals with files sorted by clientFileId, so it is independent of
 * input property ordering and file array ordering.
 */
export function canonicalFingerprint(
  command: CreateUploadCommandInput,
): string {
  const canonical = JSON.stringify({
    tenantId: command.tenantId,
    providerId: command.providerId,
    galleryId: command.galleryId,
    files: [...command.files]
      .map((file) => ({
        clientFileId: file.clientFileId,
        fileName: file.fileName,
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
      }))
      .sort((a, b) =>
        a.clientFileId < b.clientFileId
          ? -1
          : a.clientFileId > b.clientFileId
            ? 1
            : 0,
      ),
  });
  return createHash("sha256").update(canonical).digest("hex");
}
