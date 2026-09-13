# Outbox journal recovery — PLA-989

Parent: PLA-919. Follow-up to the dispatcher durability work in loyalty PR #77.

## Confirmed defect and decision

Three SQLite-backed regressions fail: a rejected remove hides a durable pending
entry, a rejected put remains in the cache and leaks into future snapshots, and
a rejected clear empties the cache without clearing storage. A retry can therefore
appear successful without removing the persisted delivery.

Keep `WebhookOutboxJournal` as the single owner. Build each candidate snapshot
inside its existing serialization queue, await storage, then publish that snapshot
to the cache. Failed writes must reject to their caller without changing cached
committed state; subsequent operations must still run. Serialize clear in the same
queue and clone input at admission so caller mutation cannot change queued data.

## Gates

- [x] Reproduce rejected put/remove/clear against real SQLite with injected
      failures only at the storage boundary.
- [ ] Implement commit-after-save semantics and queued clear.
- [ ] Test successful retry/reopen, concurrent admission order, input isolation
      and clear versus later put. Run full PostgreSQL-backed verify, audit,
      generated/package checks, review, then normal merge to dev.

No new table or provider call. This remains single-writer journal storage, not
distributed leasing, atomic engine-event enqueue or exactly-once HTTP delivery.
