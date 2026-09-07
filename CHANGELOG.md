# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-09-07

### Added

- `createUploadSession` use case: gallery access checks (no existence leaks),
  ACTIVE-status enforcement, 1–50 file validation, size/sha256/extension
  checks, unsafe-filename rejection, server-generated object keys, 15-minute
  expiry via injected `Clock`.
- Atomic quota primitives (`reserveBytes` / `commitBytes` / `releaseBytes`)
  enforcing `usedBytes + reservedBytes <= limitBytes` inside the repository.
- Tenant-scoped idempotency with canonical SHA-256 payload fingerprints;
  concurrent duplicates resolved by atomic `saveIfAbsent`.
- `cancelUploadSession` / `completeUploadSession` with compare-and-set status
  transitions, guaranteeing exactly-once quota release/commit.
- Failure atomicity: reservations are compensated when persistence fails.
- In-memory infrastructure mirroring PostgreSQL conditional-UPDATE semantics.
- 57 tests (Vitest) covering concurrency races, idempotency, quota invariants,
  cancellation/completion semantics, and batch (no N+1) repository behavior.
- Runnable demo (`npm run demo`), CI workflow, and full documentation set.

[1.0.0]: https://github.com/y9090oussefwork/pixsync-upload-session-core/releases/tag/v1.0.0
