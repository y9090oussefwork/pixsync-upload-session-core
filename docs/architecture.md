# Architecture

## Layering

```text
src/
  domain/            entities + error codes (zero dependencies)
  application/       use cases + ports (depends only on domain)
  infrastructure/    in-memory adapters (implements ports; depends on domain + ports)
```

Dependencies point inward only. The use cases receive their collaborators as
injected ports (`GalleryRepository`, `TenantStorageAccountRepository`,
`UploadSessionRepository`, `Clock`, `IdGenerator`), so the business layer never
imports an infrastructure class. Tests and the demo wire the in-memory
adapters; production would wire PostgreSQL-backed ones.

## The three use cases

### `createUploadSession`

1. Validate the command (fail fast, before any repository call).
2. Load the gallery. Missing / cross-tenant / cross-provider all produce the
   byte-identical `GALLERY_NOT_FOUND` — foreign resource existence is never
   leaked. `LOCKED` produces `GALLERY_LOCKED`.
3. Compute the canonical fingerprint of the logical payload.
4. Fast-path idempotency: an existing session for `(tenantId, idempotencyKey)`
   is replayed (same fingerprint) or rejected with `IDEMPOTENCY_CONFLICT`.
5. **Atomically reserve** the total requested bytes. Rejection →
   `QUOTA_EXCEEDED`.
6. Build the session aggregate: server-generated ids and object keys,
   `expiresAt = clock.now() + 15 min`.
7. Persist with `saveIfAbsent` (unique-key semantics). Any failure triggers
   compensation: the reservation is released before the error surfaces
   (`PERSISTENCE_FAILURE`).
8. If a concurrent duplicate won the insert, release the now-redundant
   reservation and replay-or-conflict against the winner.

### `cancelUploadSession`

Tenant-scoped lookup (`UPLOAD_SESSION_NOT_FOUND` for missing *and* foreign
sessions) → already `CANCELLED` returns idempotently → `COMPLETED` is rejected
→ otherwise a compare-and-set `PENDING → CANCELLED` elects exactly one winner,
and only the winner releases the reservation.

### `completeUploadSession`

Confirmation-set validation (no duplicates, no unknown ids, all expected ids
confirmed) runs **before** the status check, so an idempotent replay of a
completed session must carry the identical set. A compare-and-set
`PENDING → COMPLETED` elects exactly one winner, and only the winner commits
the reservation (`reserved → used`, atomically, in one primitive).

## Quota correctness

The invariant `usedBytes + reservedBytes <= limitBytes` is enforced **inside**
single repository primitives — never by read-compare-write in the service:

| Port method | Semantics | PostgreSQL equivalent |
|---|---|---|
| `reserveBytes(t, n)` | check `used+reserved+n <= limit`, then `reserved += n` | `UPDATE ... SET reserved_bytes = reserved_bytes + $n WHERE tenant_id = $t AND used_bytes + reserved_bytes + $n <= limit_bytes` (0 rows → exceeded) |
| `commitBytes(t, n)` | check `reserved >= n`, then `reserved -= n; used += n` | `UPDATE ... SET reserved_bytes = reserved_bytes - $n, used_bytes = used_bytes + $n WHERE ... AND reserved_bytes >= $n` |
| `releaseBytes(t, n)` | check `reserved >= n`, then `reserved -= n` | `UPDATE ... SET reserved_bytes = reserved_bytes - $n WHERE ... AND reserved_bytes >= $n` |

The in-memory adapters cross an async I/O boundary (`setImmediate`) before
each operation — simulating database latency and *widening* the race window —
then execute a synchronous check-and-set critical section. Node's
single-threaded execution makes that section atomic with respect to
interleaved async callers, which is exactly the guarantee a conditional
`UPDATE` provides in PostgreSQL. The 80 MB vs 80 MB concurrent race test
passes deterministically because of this.

## Exactly-once effects under concurrency

Status transitions are the linearization points:

- `compareAndSetStatus(PENDING → CANCELLED)` gates quota **release**
- `compareAndSetStatus(PENDING → COMPLETED)` gates quota **commit**

Losing callers observe the new state and return idempotently (or with
`INVALID_SESSION_STATE` when the rules forbid it), so bytes can never be
released or committed twice even when two requests race.

## Idempotency

- Scoped to `(tenantId, idempotencyKey)` — two tenants may reuse a key freely.
- The stored `fingerprint` is a SHA-256 over a canonical serialization: fixed
  field order, files sorted by `clientFileId`. Input property ordering and
  file array ordering cannot affect it.
- Concurrent identical requests are resolved by the atomic `saveIfAbsent`:
  the loser releases its redundant reservation and returns the winner's
  session (or `IDEMPOTENCY_CONFLICT` if payloads differ).

## Batch persistence (no N+1)

A session is one aggregate; its files are part of it. `saveIfAbsent` writes
all 50 files in a single call. Tests instrument every repository method through
a Proxy counter layer and assert the exact call counts (e.g. a 50-file create
performs exactly 2 session-repository calls).

## Security posture

- Object keys are server-generated: `tenants/{tenantId}/galleries/{galleryId}/{serverId}.{ext}`.
  The raw filename never reaches a storage key; only the whitelisted,
  lowercased extension is reused.
- Filenames containing path traversal (`..`), directory separators (`/`, `\`),
  or control characters are rejected.
- `sha256` must be exactly 64 lowercase hex characters; sizes are bounded to
  `(0, 2 GiB]`.
- Error messages are generic and identical across "missing" vs "foreign"
  resources, so the API cannot be used to probe other tenants' data.

## Replacing the in-memory layer with PostgreSQL

1. Implement the three port interfaces with a SQL driver; the conditional
   `UPDATE`s above are drop-in translations.
2. Add `UNIQUE (tenant_id, idempotency_key)` on `upload_sessions` and a
   `files` JSONB column (or a child table written in one batch statement).
3. Wrap `compareAndSetStatus` + `commitBytes` in one transaction per use case.
4. No changes to `domain/` or `application/` are required.

## Known limitations

- `expiresAt` is recorded but not enforced by cancel/complete, and no expiry
  sweep releases reservations from abandoned PENDING sessions (roadmap item).
- The in-memory adapters are per-process; the atomicity argument relies on
  Node's single-threaded event loop, which is precisely why the port contract
  is expressed as conditional-UPDATE semantics.
