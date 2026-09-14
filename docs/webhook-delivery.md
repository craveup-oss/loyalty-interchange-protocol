# Webhook delivery

The reference platform can push CloudEvents to HTTP receivers using the
signature profile defined in [`spec/webhooks.md`](../spec/webhooks.md). Events
are emitted after successful mutations:

| Operation              | Event type                                          |
| ---------------------- | --------------------------------------------------- |
| Member enrollment      | `org.loyalty-interchange.member.enrolled.v1`        |
| Accrual posted         | `org.loyalty-interchange.order.accrued.v1`          |
| Order adjusted         | `org.loyalty-interchange.order.adjusted.v1`         |
| Redemption reserved    | `org.loyalty-interchange.redemption.reserved.v1`    |
| Redemption captured    | `org.loyalty-interchange.redemption.captured.v1`    |
| Redemption reversed    | `org.loyalty-interchange.redemption.reversed.v1`    |
| Issued reward created  | `org.loyalty-interchange.issued-reward.issued.v1`   |
| Issued reward redeemed | `org.loyalty-interchange.issued-reward.redeemed.v1` |
| Issued reward restored | `org.loyalty-interchange.issued-reward.restored.v1` |
| Issued reward cancelled| `org.loyalty-interchange.issued-reward.cancelled.v1`|

Event ids are derived from the underlying resource ids (ledger entry,
reservation, member), so idempotent request replays re-deliver events with the
same CloudEvent `source` + `id`. Receivers deduplicate on that pair, as the
spec requires.

## PostgreSQL transaction boundary

Managed operations through `executeEngineOperation` commit engine state and
captured event recipients together in `lip_engine_event_outbox`. Startup,
post-mutation handoff and a 30-second retry timer transfer these events into the
existing delivery journal. Source rows are acknowledged only after durable
admission, not after a fire-and-forget call. Removed recipients are canceled;
paused recipients remain queued. New subscriptions do not receive earlier
pending events. Erasure removes still-pending source payloads for that member;
it cannot recall delivered webhooks or erase existing delivery history.

An interrupted acknowledgement can produce duplicate deliveries with the same
source/id. Receivers must still deduplicate. This is not a distributed lease:
managed services remain single-instance. SQLite/demo calls do not share this
PostgreSQL guarantee. Before runtime rollback, freeze writes and inspect/drain
the new source table; retain it because old code cannot recover its rows.

## Enabling delivery

Set environment variables before starting the server:

```bash
LIP_WEBHOOK_URL=https://receiver.example/hooks \
LIP_WEBHOOK_SECRET=your-shared-secret \
npm run lip -- serve --port 4010 --api-key local-dev-key
```

Optionally restrict the delivered event types with a comma-separated
allowlist:

```bash
LIP_WEBHOOK_EVENTS=org.loyalty-interchange.order.accrued.v1,org.loyalty-interchange.redemption.captured.v1
```

Programmatic embedders can pass subscriptions directly:

```ts
import { createDemoPlatform } from "@loyalty-interchange/server";

const platform = await createDemoPlatform({
  databasePath: "./data/reference.db",
  webhooks: [{ url: "https://receiver.example/hooks", secret: "your-shared-secret" }]
});
```

Webhook destinations must use public HTTPS by default. The dispatcher rejects
credentials, fragments, loopback/private/reserved addresses, and DNS answers
that include a non-public address; delivery also refuses redirects. For a
loopback or private receiver in local development only, set
`LIP_ALLOW_PRIVATE_WEBHOOK_NETWORKS=true` or pass
`allowPrivateWebhookNetworks: true`. Never enable that escape hatch on a
networked deployment.

Subscriptions can also be added, deleted, and rotated at runtime from the
Admin **API** view. Runtime subscriptions persist in SQLite and take precedence
over boot-time environment configuration after their first write. Signing
secrets are write-only in Admin responses. The local reference runtime stores
them in its protected SQLite database; production adapters should use envelope
encryption or an external secret manager.

`platform.webhooks` exposes the dispatcher, including `flush()` to await the
current retry cycle, `pendingDeliveries()` for the durable queue, and
`deliveries()` for recent process-local delivery results.

## Delivery semantics

The outbox journal serializes puts, removals and clears, and changes its cached
snapshot only after storage succeeds. A rejected storage operation may have
committed before losing its acknowledgement, so the journal reloads durable state
before its next read/write. If that read also fails, it refuses to overwrite the
unknown state. This protects single-writer recovery; it is not distributed leasing.
The journal itself does not make engine mutations atomic with event enqueue; on
PostgreSQL that guarantee comes from the engine event outbox described above.

Before each HTTP attempt, the dispatcher awaits its outbox write. A storage
failure stops that cycle without sending, keeps the entry pending in the running
process, and reports through `onError`. After storage recovers, use the existing
pending-delivery retry action. Pausing/removing a subscription while storage or
DNS is pending prevents a new send; an already transmitted request cannot be undone.

After a 2xx response, durable history is saved before the pending outbox entry is
removed. A failure in either completion write does not repeat the HTTP request
inside that retry cycle. A later retry/restart may still redeliver, so receiver
deduplication remains mandatory. History and outbox completion are not one
transaction.

Engine mutations and event enqueue are atomic on PostgreSQL:
`executeEngineOperation` commits engine state and pending events to
`lip_engine_event_outbox` in one transaction, and an event whose first handoff
fails stays there until startup, a later mutation or the 30-second timer admits
it. They are still not atomic on SQLite/demo mode: engine state and the outbox
entry are separate writes and the enqueue is not awaited, so an initial enqueue
failure followed by process death can still lose that event.
None of these safeguards is distributed leasing; keep the single-instance restriction
until PLA-919's multi-instance work and sandbox proof are complete.

- Each event is POSTed as JSON with `LIP-Webhook-Timestamp` and
  `LIP-Webhook-Signature: v1=<base64url>` headers.
- The destination is checked again before every attempt, and redirects are not
  followed.
- Failed deliveries (network errors or non-2xx responses) are retried with
  exponential backoff, three attempts per process run by default.
- Pending deliveries are stored in SQLite under a separate webhook-outbox
  state key. A normal server restart reloads and retries them; successful 2xx
  deliveries are removed. `--reset` clears both loyalty state and the outbox.
- Delivery is at-least-once. Receivers must verify the signature over the raw
  body and deduplicate using CloudEvent `source` + `id`.
- Receivers can verify with the SDK: `verifyWebhook` in
  `@loyalty-interchange/sdk`.

## Operator visibility

The Admin dashboard's **Developer** view manages persisted receivers and secret
rotation, shows pending outbox entries, retry attempts, last errors, and durable
completed outcomes, and can immediately retry pending deliveries or replay a
completed event. Deleting a receiver also removes its pending deliveries.
Completed history and event payloads are retained in SQLite up to the configured
history limit. Programmatic and Admin API subscription writes may set
`retry_policy` with `max_attempts`, `backoff_ms`, and `timeout_ms`; omitted
values use the server defaults.

### Cutover health probe

Authenticated Admin clients can poll a secret-free summary before unfreezing a
BFF cutover:

```bash
curl -s http://127.0.0.1:3210/admin/api/v1/webhooks/health \
  -H "Authorization: Bearer $LIP_API_KEY"
```

The response includes `enabled`, pending outbox count, recent delivered/failed
counts, `success_rate`, and `healthy` (`true` when webhooks are enabled, the
outbox is empty, and no retained recent delivery failed).
