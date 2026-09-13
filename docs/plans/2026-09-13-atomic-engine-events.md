# Atomic PostgreSQL engine events — PLA-990

Status: implemented, awaiting exact-head PR verification and merge. No deployment
or scale-out authorization.

## Decision

Managed PostgreSQL engine mutations and their pending webhook events must commit
in one transaction. A process lease alone cannot fix a crash between the two
writes, and introducing a broker would introduce another dual-write boundary.
Use an additive normalized event outbox alongside the existing engine tables.
The existing webhook dispatcher remains the only HTTP delivery owner.

Capture active, matching subscription IDs and URLs at emission time, without
secrets. Revalidate those identities during handoff. A removed subscription is a
cancellation; a paused subscription retains its delivery without sending. A new
subscription never receives historical events merely because recovery ran later.
Current credentials are used, so rotation does not persist old secrets.

The source row is removed only after all selected deliveries have been durably
accepted by the existing journal. An acknowledgement lost after acceptance may
produce a duplicate with the same CloudEvent source/id: this is at-least-once,
not exactly-once. Pending duplicate identities keep the first envelope. No
automatic expiry silently discards financial events.

Erasing a member removes still-pending source events for that subject in the
same engine transaction. This does not recall already accepted/sent webhooks or
claim that existing history/customer-profile stores implement complete erasure.
Engine reset cascades to the source outbox. Ordinary updates must not delete it.

## Implementation and verification

- [x] Add migration 004: tenant/program FK, event identity uniqueness, bounded
  read index, FORCE RLS and runtime-role grants. Do not rewrite old migrations.
- [x] Extend the existing repository mutation owner with a collected-events
  callback, called after the operation but before commit. Test success,
  rollback on invalid event persistence, restart, replay and tenant isolation
  against real PostgreSQL; test erasure and reset.
- [x] Add awaited dispatcher admission using captured recipients. Keep the
  existing synchronous emit facade for standalone callers. A failed durable
  write must reject admission, not acknowledge the source event.
- [x] Wire managed platform emission into the transaction; recover at startup,
  after mutations and on a serialized 30-second timer. Stop/drain that timer
  before journals and the pool close. Delivery failure must not report a
  committed points operation as rolled back.
- [x] Test crash/restart handoff, recipient changes and storage rejection.
- [ ] Run full PostgreSQL verify, dependency audit, spec and release checks;
  self-review, address justified GitHub comments and normal-merge exact head.

## Operational boundaries and rollback

This closes the PostgreSQL engine-to-event write gap only. Whole-document
delivery/subscription journals and schedulers still require the remaining
PLA-919 distributed coordination work. Keep every managed service at one
instance. SQLite/demo mode is not given a false transactional guarantee.

Migration 004 is additive and startup-applied using the existing migration
owner. No historical events are invented. Before rolling back runtime code,
freeze writes and drain/count the new table under each tenant scope; old code
cannot recover these rows. Keep the table and rows on rollback, restore this
reader before resuming pending delivery, and never drop it as a shortcut. No
managed migration or rollback has been exercised by this local implementation.
