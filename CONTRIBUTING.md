# Contributing

Thanks for your interest in improving PixSync Upload Session Core!

## Ground rules

This codebase is small on purpose. Before opening a PR:

- **Quota correctness is non-negotiable.** The invariant
  `usedBytes + reservedBytes <= limitBytes` must be enforced inside atomic
  repository primitives — never by read-compare-write in the service layer.
- **Exactly-once effects.** Quota release/commit must remain gated behind
  compare-and-set status transitions.
- **No information leaks.** Missing and cross-tenant resources must stay
  indistinguishable in both error code and message.
- **No new runtime dependencies.** This core is dependency-free by design.
- **Deterministic tests.** Injected `Clock`/`IdGenerator` only — no sleeps,
  no randomness.

## Development workflow

```bash
git clone https://github.com/<your-fork>/pixsync-upload-session-core.git
cd pixsync-upload-session-core
npm install

npm run typecheck   # must stay clean (strict mode)
npm test            # all tests must pass
npm run demo        # end-to-end walkthrough still works
```

## Submitting changes

1. Fork the repository and create a branch from `main`
   (`feat/...`, `fix/...`, `docs/...`).
2. Keep commits focused; use [Conventional Commits](https://www.conventionalcommits.org/)
   (`fix: release reservation when idempotent replay conflicts`).
3. Add or update tests for any behavior change — especially anything touching
   quota, idempotency, or state transitions. Concurrency properties need a
   test that would fail under a naive read-compare-write implementation.
4. Ensure `npm run typecheck`, `npm test`, and `npm run demo` all pass
   (CI runs them on Node 20 and 22).
5. Open a PR describing the *why*, not just the *what*. Link related issues.

## Reporting issues

Use the issue templates. For quota/concurrency bugs, include the exact
sequence of operations and expected vs. actual byte accounting.

## Security vulnerabilities

Please do **not** open a public issue. See [SECURITY.md](SECURITY.md).
