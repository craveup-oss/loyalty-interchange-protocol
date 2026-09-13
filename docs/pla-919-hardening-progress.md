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

## Second bounded increment: control-plane route isolation

Implemented the issue's explicitly permitted route-test alternative to changing
repository signatures. The HTTP matrix exercises all 18 existing-tenant route
variants for outsiders, inactive memberships and foreign-scoped operators.
Every denial must reach the real membership lookup for the target organization
and return its authorization-specific 404, not validation or routing failure.
Credential/operation hooks and audit/project/environment state remain untouched.
A mounted-handler inventory forces a new control-plane handler to receive an
explicit authorization disposition. Authentication itself retains its existing
OIDC/operator suites; this matrix injects identities at that boundary only.

Mutation proof: removing the environment-list membership check caused all three
actor cases to fail with a leaked 200. The check was restored. Full `npm run
verify` with disposable local PostgreSQL passes 65 files / 493 tests, zero skips,
including types, coverage, builds, examples, packages and docs. No production
authorization implementation, schema or managed resources changed.

The cloud API and managed-runtime error responses now use the engine/wallet and
documented `https://loyalty-interchange.org/problems/` namespace. HTTP regressions
for cloud authorization, customer authentication and managed runtime errors
failed against the old host and pass with the aligned host. Status, code and
detail semantics are unchanged. Full verification remains 65 files / 493 tests.

## Still required before scale-out

1. Keep the route membership inventory current. Repository signatures remain
   unchanged under the issue's route-test alternative; this is not control-plane
   row-level security or a claim that privileged worker reads are tenant-scoped.
2. Scheduler, webhook-dispatch and credential-operation coordination. Reuse
   existing PostgreSQL coordination where applicable, but do not assume a lease
   makes an external webhook exactly-once: retries need stable event identity
   and receiver idempotency, and ownership loss must fence state commits.
3. Remaining catalogue ownership simplification, lint and PostgreSQL storage
   coverage. Problem-type host alignment is complete in the second increment.
4. Two-instance sandbox evidence for concurrency, restart, lease loss and
   recovery. Keep the existing one-instance deployment restriction until this
   evidence is recorded. This increment does not authorize paid scale-out or
   declare PLA-919 complete.

Rollback: revert this code increment. There is no database schema migration or
existing-price rewrite to reverse.
