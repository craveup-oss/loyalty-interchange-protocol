# Webhook attempt durability — PLA-987

Parent: PLA-919. This is a bounded prerequisite, not a scale-out certificate.

## Decision

Keep `WebhookDispatcher` and its existing outbox/history interfaces. Its current
fire-and-forget persistence allows HTTP delivery before the attempt is durable,
including when storage rejects the write. Serialize writes as today but await
the attempt write before network I/O. Storage failure stops this delivery cycle,
leaves it pending, and reports through the existing error callback. Callers can
retry after storage recovers without inventing a new event or signature format.

Before recording successful completion, save history first, remove the outbox
entry second, and only then remove in-memory pending evidence. A failed local
completion must not start another network attempt in the same cycle. Across a
crash/restart the delivery remains at-least-once: receivers deduplicate by the
stable CloudEvent identity. Do not promise exactly-once HTTP effects.

Recheck current subscription state after asynchronous storage/DNS boundaries so
a pause/removal during those waits cannot initiate a new send. An already sent
request cannot be undone; its durable completion still needs reconciliation.

## Steps and gates

- [x] Reproduce blocked/rejected outbox writes permitting a network send.
- [x] Fix the existing serialization owner, without adding another dispatcher.
- [x] Test recovery, completed-history failure, outbox-removal failure and
      pause/removal races. Keep existing signing and restart tests.
- [x] Run `npm run verify`, review the exact diff and current GitHub comments,
      fix justified findings, then normal merge to `dev`.

## Explicitly still open under PLA-919

- Durable multi-process ownership, fencing and fresh subscription/credential
  state; process-local queues are not distributed leases.
- Atomic engine mutation/event-outbox persistence. A failed initial enqueue
  followed by process death is not solved by this delivery-boundary fix.
- Atomic history/outbox completion across independent stores. A crash between
  those writes can redeliver; receiver idempotency remains required.
- Two-instance sandbox concurrency/restart evidence and approval for any paid
  infrastructure. Keep the existing single-instance configuration.

No managed database, deployment, credential or pricing changes in this PR.

## Verification

`npm run verify` passed with an explicitly disposable local PostgreSQL database:
65 suites / 503 tests, including the PostgreSQL tests rather than skipping them.
Coverage: 86.97% statements, 77.70% branches, 93.57% functions, 88.38% lines.
Generation, types, example execution, TypeScript/admin builds, package checks,
documentation mirror and launch-surface checks passed. The targeted webhook and
store suites passed 29 tests. Review also caught and preserved zero-history-limit
behavior; emitted event snapshots now remain stable if a caller mutates its
original object during asynchronous delivery.

Reviewed and normally merged through PR #77. Exact head `ade3f9e` passed hosted
verification with no outstanding review comments; dev merge `0df48eb` has the
same tree. The explicit distributed-work limitations above remain open.
