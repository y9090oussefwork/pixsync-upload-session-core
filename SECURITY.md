# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 1.x | ✅ |

## Reporting a vulnerability

Please report security issues **privately** via
[GitHub Security Advisories](https://github.com/y9090oussefwork/pixsync-upload-session-core/security/advisories/new)
— never through a public issue.

A report is especially valuable if it demonstrates:

- a way to break `usedBytes + reservedBytes <= limitBytes` through concurrent
  use-case calls,
- quota double-release / double-commit under races,
- a leaked reservation after a persistence failure,
- cross-tenant information disclosure through error codes, messages, or
  timing-revealing behavior,
- object-key injection (raw filename influence on storage paths).

We aim to acknowledge reports within 72 hours and will coordinate disclosure
timing with you.

## Design-level mitigations already in place

- Atomic check-and-set quota primitives (no read-compare-write races).
- Compare-and-set status transitions → exactly-once quota effects.
- Reservation compensation on persistence failure.
- Server-generated object keys; unsafe filenames rejected (traversal,
  separators, control characters).
- Indistinguishable not-found errors across tenants.
- Strict input validation (sizes, digests, extensions, counts).
