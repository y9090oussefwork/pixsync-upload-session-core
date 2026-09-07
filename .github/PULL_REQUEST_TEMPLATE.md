## Why

<!-- What problem does this solve? Link issues. -->

## What changed

<!-- Bullet the notable behavior/API changes. -->

## Invariant checklist

- [ ] `usedBytes + reservedBytes <= limitBytes` still enforced atomically
- [ ] Quota release/commit still gated by compare-and-set transitions
- [ ] Missing vs cross-tenant resources remain indistinguishable
- [ ] No new runtime dependencies
- [ ] Tests are deterministic (injected `Clock`/`IdGenerator`, no sleeps)

## Verification

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] `npm run demo` passes
