import type { PostgresEngineRepository } from "@loyalty-interchange/storage-postgres";
import type { WebhookDispatcher } from "./webhooks.js";

/** Single-instance durable handoff, not a distributed delivery lease. */
export class EngineEventPump {
  private running: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  public constructor(
    private readonly repository: Pick<PostgresEngineRepository, "listPendingEvents" | "acknowledgeEvent">,
    private readonly dispatcher: Pick<WebhookDispatcher, "enqueue">,
    private readonly onError: () => void
  ) {}

  public start(): void {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => { void this.drain(); }, 30_000);
    this.timer.unref();
  }

  public drain(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.run().catch(() => {
      // The engine transaction has already committed. Do not turn an event
      // handoff failure into an apparent failed points operation or log PII.
      this.onError();
    }).finally(() => { this.running = undefined; });
    return this.running;
  }

  private async run(): Promise<void> {
    // Bound each turn; later ticks continue a large backlog without an
    // unbounded startup or shutdown operation.
    for (let batch = 0; batch < 10 && !this.closed; batch += 1) {
      const events = await this.repository.listPendingEvents();
      for (const pending of events) {
        if (this.closed) return;
        await this.dispatcher.enqueue(pending.event, pending.recipients);
        await this.repository.acknowledgeEvent(pending.outbox_id);
      }
      if (events.length < 100) return;
    }
  }

  public async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
