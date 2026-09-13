# PLA-919 hardening progress

## First bounded increment

- Restore the Business plan in the in-memory control plane with the same price,
  included usage and limits as the existing SQL seed. A PostgreSQL-backed parity
  test prevents silent drift. Existing database plans are not updated.
- Acquire each migrator's transaction advisory lock before creating its own
  tracking table. `CREATE TABLE IF NOT EXISTS` alone does not serialize the
  PostgreSQL catalogue; simultaneous fresh starts previously collided on
  `pg_type_typname_nsp_index`. Both cloud and engine migrations now protect that
  first write. No historical migration or persisted tenant data is rewritten.

Verification: `npm run verify` with `LIP_TEST_POSTGRES_URL` pointing only to a
fresh disposable local database passed: 64 test files, 489 tests, zero skips;
coverage, generated contracts, types, build, examples, package and docs gates
passed. The lock-order regression failed for both migrators before the fix.

## Still required before scale-out

1. Organization-scoped control-plane authorization/read contracts and exhaustive
   cross-organization route tests.
2. Scheduler, webhook-dispatch and credential-operation coordination. Reuse
   existing PostgreSQL coordination where applicable, but do not assume a lease
   makes an external webhook exactly-once: retries need stable event identity
   and receiver idempotency, and ownership loss must fence state commits.
3. Unified problem-type host, remaining catalogue ownership simplification,
   lint and PostgreSQL storage coverage.
4. Two-instance sandbox evidence for concurrency, restart, lease loss and
   recovery. Keep the existing one-instance deployment restriction until this
   evidence is recorded. This increment does not authorize paid scale-out or
   declare PLA-919 complete.

Rollback: revert this code increment. There is no database schema migration or
existing-price rewrite to reverse.
