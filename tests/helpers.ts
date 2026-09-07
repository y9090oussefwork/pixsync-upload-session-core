import { expect } from "vitest";
import {
  AppError,
  createUploadSessionCore,
  FixedClock,
  InMemoryGalleryRepository,
  InMemoryTenantStorageAccountRepository,
  InMemoryUploadSessionRepository,
  SequenceIdGenerator,
  type CreateUploadSessionCommand,
  type ErrorCode,
  type Gallery,
  type TenantStorageAccount,
  type UploadFileRequest,
  type UploadSessionCore,
} from "../src/index.js";

export const MB = 1024 * 1024;
export const VALID_SHA = "a".repeat(64);

export const DEFAULT_GALLERIES: Gallery[] = [
  { id: "g-1", tenantId: "t-1", providerId: "p-1", status: "ACTIVE" },
  { id: "g-locked", tenantId: "t-1", providerId: "p-1", status: "LOCKED" },
  { id: "g-other-tenant", tenantId: "t-2", providerId: "p-1", status: "ACTIVE" },
  { id: "g-other-provider", tenantId: "t-1", providerId: "p-2", status: "ACTIVE" },
];

export const DEFAULT_ACCOUNTS: TenantStorageAccount[] = [
  { tenantId: "t-1", limitBytes: 100 * MB, usedBytes: 0, reservedBytes: 0 },
  { tenantId: "t-2", limitBytes: 100 * MB, usedBytes: 0, reservedBytes: 0 },
];

export function makeFile(
  overrides: Partial<UploadFileRequest> = {},
): UploadFileRequest {
  return {
    clientFileId: "file-1",
    fileName: "photo.jpg",
    sizeBytes: 1 * MB,
    sha256: VALID_SHA,
    ...overrides,
  };
}

export function makeFiles(count: number, sizeBytes = 1 * MB): UploadFileRequest[] {
  return Array.from({ length: count }, (_, index) =>
    makeFile({
      clientFileId: `file-${index + 1}`,
      fileName: `photo-${index + 1}.png`,
      sizeBytes,
    }),
  );
}

export function makeCommand(
  overrides: Partial<CreateUploadSessionCommand> = {},
): CreateUploadSessionCommand {
  return {
    tenantId: "t-1",
    providerId: "p-1",
    galleryId: "g-1",
    idempotencyKey: "key-1",
    files: [makeFile()],
    ...overrides,
  };
}

export type CallCounts = Record<string, number>;

/**
 * Repository instrumentation: counts every port method call so tests can
 * prove batch behavior (no per-file queries/writes) and exactly-once quota
 * effects.
 */
export function instrument<T extends object>(target: T, counts: CallCounts): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof value === "function" && typeof prop === "string") {
        return (...args: unknown[]) => {
          counts[prop] = (counts[prop] ?? 0) + 1;
          return (value as (...a: unknown[]) => unknown).apply(obj, args);
        };
      }
      return value;
    },
  });
}

export interface Harness {
  core: UploadSessionCore;
  clock: FixedClock;
  ids: SequenceIdGenerator;
  galleries: InMemoryGalleryRepository;
  accounts: InMemoryTenantStorageAccountRepository;
  sessions: InMemoryUploadSessionRepository;
  counts: {
    galleries: CallCounts;
    accounts: CallCounts;
    sessions: CallCounts;
  };
}

export function makeHarness(
  options: {
    gallerySeed?: Gallery[];
    accountSeed?: TenantStorageAccount[];
    sessions?: InMemoryUploadSessionRepository;
  } = {},
): Harness {
  const clock = new FixedClock(1_700_000_000_000);
  const ids = new SequenceIdGenerator("gen");
  const galleries = new InMemoryGalleryRepository(
    options.gallerySeed ?? DEFAULT_GALLERIES,
  );
  const accounts = new InMemoryTenantStorageAccountRepository(
    options.accountSeed ?? DEFAULT_ACCOUNTS,
  );
  const sessions = options.sessions ?? new InMemoryUploadSessionRepository();
  const counts = {
    galleries: {} as CallCounts,
    accounts: {} as CallCounts,
    sessions: {} as CallCounts,
  };
  const core = createUploadSessionCore({
    galleries: instrument(galleries, counts.galleries),
    accounts: instrument(accounts, counts.accounts),
    sessions: instrument(sessions, counts.sessions),
    ids,
    clock,
  });
  return { core, clock, ids, galleries, accounts, sessions, counts };
}

export async function grabError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

export async function expectAppError(
  promise: Promise<unknown>,
  code: ErrorCode,
): Promise<AppError> {
  const error = await grabError(promise);
  expect(error, `expected AppError with code ${code}`).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
  return error as AppError;
}
