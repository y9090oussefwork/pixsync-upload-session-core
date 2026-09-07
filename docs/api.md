# API Reference

All entry points are exported from the package root (`src/index.ts`).

## `createUploadSessionCore(deps): UploadSessionCore`

Composition root. Wires the three use cases against injected ports.

```ts
interface UploadSessionCoreDeps {
  galleries: GalleryRepository;
  accounts: TenantStorageAccountRepository;
  sessions: UploadSessionRepository;
  ids: IdGenerator;
  clock: Clock;
}
```

---

## Use cases

### `core.createUploadSession(command): Promise<UploadSession>`

Creates a PENDING session and atomically reserves its total bytes.

```ts
interface CreateUploadSessionCommand {
  tenantId: string;
  providerId: string;
  galleryId: string;
  idempotencyKey: string;      // unique per (tenantId, idempotencyKey)
  files: UploadFileRequest[];  // 1..50 entries
}

interface UploadFileRequest {
  clientFileId: string;        // unique within the request
  fileName: string;            // display name; never used in object keys
  sizeBytes: number;           // integer, 0 < n <= 2 GiB
  sha256: string;              // 64 lowercase hex characters
}
```

**Rules**

| # | Rule | Failure |
|---|---|---|
| 1 | Gallery must exist and belong to both `tenantId` and `providerId` | `GALLERY_NOT_FOUND` (identical for missing/foreign) |
| 2 | Gallery must be `ACTIVE` | `GALLERY_LOCKED` |
| 3 | 1–50 files, unique `clientFileId`s | `INVALID_UPLOAD` |
| 4 | `0 < sizeBytes <= 2 GiB` (integer) | `INVALID_UPLOAD` |
| 5 | `sha256` matches `/^[0-9a-f]{64}$/` | `INVALID_UPLOAD` |
| 6 | Extension in `.jpg .jpeg .png .webp .heic` (case-insensitive) | `INVALID_UPLOAD` |
| 7 | No path traversal / separators / control characters in `fileName` | `INVALID_UPLOAD` |
| 8 | Total bytes must fit `limit - used - reserved` | `QUOTA_EXCEEDED` |
| 9 | Same key + same payload → original session; same key + different payload → conflict | `IDEMPOTENCY_CONFLICT` |

**Object keys** are server-generated:
`tenants/{tenantId}/galleries/{galleryId}/{generatedId}.{lowercaseExt}`.

**Expiry**: `expiresAt = clock.now() + 15 minutes`.

### `core.cancelUploadSession(tenantId, sessionId): Promise<UploadSession>`

- Tenant-scoped; foreign or missing sessions → `UPLOAD_SESSION_NOT_FOUND` (identical messages).
- `PENDING` → atomically transitions to `CANCELLED` and releases the reservation **exactly once**.
- Already `CANCELLED` → returns the session (idempotent).
- `COMPLETED` → `INVALID_SESSION_STATE`.

### `core.completeUploadSession(tenantId, sessionId, confirmedClientFileIds): Promise<UploadSession>`

- Tenant-scoped; foreign or missing sessions → `UPLOAD_SESSION_NOT_FOUND`.
- The confirmation set must contain **every** expected `clientFileId`, **no** unknown ids, and **no** duplicates — otherwise `INVALID_UPLOAD` (state untouched).
- `PENDING` → atomically transitions to `COMPLETED` and moves `reservedBytes → usedBytes` **exactly once**.
- Already `COMPLETED` with the same set → returns the session (idempotent).
- `CANCELLED` → `INVALID_SESSION_STATE`.

---

## Domain types

```ts
type GalleryStatus = "ACTIVE" | "LOCKED";

interface Gallery {
  id: string;
  tenantId: string;
  providerId: string;
  status: GalleryStatus;
}

interface TenantStorageAccount {
  tenantId: string;
  limitBytes: number;
  usedBytes: number;
  reservedBytes: number;
}

type UploadSessionStatus = "PENDING" | "COMPLETED" | "CANCELLED";

interface UploadSessionFile extends UploadFileRequest {
  objectKey: string;
}

interface UploadSession {
  id: string;
  tenantId: string;
  providerId: string;
  galleryId: string;
  idempotencyKey: string;
  fingerprint: string;   // canonical SHA-256 of the logical request
  status: UploadSessionStatus;
  reservedBytes: number;
  createdAt: number;     // epoch ms
  expiresAt: number;     // createdAt + 15 min
  files: UploadSessionFile[];
}
```

## Errors

All failures throw `AppError`:

```ts
class AppError extends Error {
  readonly code: ErrorCode;
}
```

| Code | Thrown by | Notes |
|---|---|---|
| `GALLERY_NOT_FOUND` | create | identical for missing / cross-tenant / cross-provider |
| `GALLERY_LOCKED` | create | gallery exists but is not ACTIVE |
| `INVALID_UPLOAD` | create, complete | request, file, or confirmation validation |
| `QUOTA_EXCEEDED` | create | atomic reservation rejected |
| `IDEMPOTENCY_CONFLICT` | create | same key, different canonical payload |
| `UPLOAD_SESSION_NOT_FOUND` | cancel, complete | identical for missing / cross-tenant |
| `INVALID_SESSION_STATE` | cancel, complete | disallowed transition |
| `PERSISTENCE_FAILURE` | create | storage failed; reservation was compensated |
| `TENANT_NOT_FOUND` | create | tenant has no storage account |

Error messages never expose tenant-sensitive internals.

## Ports (for custom adapters)

```ts
interface Clock { now(): number }
interface IdGenerator { next(): string }

interface GalleryRepository {
  findById(galleryId: string): Promise<Gallery | null>;
}

interface TenantStorageAccountRepository {
  reserveBytes(tenantId: string, amountBytes: number): Promise<ReserveOutcome>;
  releaseBytes(tenantId: string, amountBytes: number): Promise<void>;
  commitBytes(tenantId: string, amountBytes: number): Promise<CommitOutcome>;
}

interface UploadSessionRepository {
  findById(tenantId: string, sessionId: string): Promise<UploadSession | null>;
  findByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<UploadSession | null>;
  saveIfAbsent(session: UploadSession): Promise<SaveSessionResult>;
  compareAndSetStatus(
    tenantId: string, sessionId: string,
    expected: UploadSessionStatus, next: UploadSessionStatus,
  ): Promise<StatusTransitionResult>;
}
```

`reserveBytes` / `commitBytes` / `saveIfAbsent` / `compareAndSetStatus` must be
**atomic check-and-set operations** in any adapter (see
[architecture.md](architecture.md) for the PostgreSQL translations).

## Bundled adapters (`infrastructure/memory`)

| Class | Purpose |
|---|---|
| `InMemoryGalleryRepository` | gallery lookup |
| `InMemoryTenantStorageAccountRepository` | atomic quota primitives (+ `snapshot()` test helper) |
| `InMemoryUploadSessionRepository` | aggregate persistence (+ `count()` test helper) |
| `FixedClock` | deterministic time (`set`, `advance`) |
| `SequenceIdGenerator` | deterministic ids (`prefix-1`, `prefix-2`, …) |
