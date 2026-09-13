import type { AsyncStateStore } from "@loyalty-interchange/storage";
import type { WebhookOutboxEntry, WebhookOutboxStore } from "./webhooks.js";

export interface WebhookOutboxState {
  version: 1;
  deliveries: WebhookOutboxEntry[];
}

/**
 * Persists pending webhook deliveries in an injected AsyncStateStore (SQLite
 * in the demo platform, tenant-scoped Postgres in cluster mode). Writes are
 * serialized in call order; the dispatcher is the single writer, so saves are
 * unconditional snapshots. Cache changes become visible only after storage
 * succeeds, so a failed write remains retryable without leaking into later saves.
 */
export class WebhookOutboxJournal implements WebhookOutboxStore {
  private readonly store: AsyncStateStore<WebhookOutboxState>;
  private entries: Map<string, WebhookOutboxEntry>;
  private tail: Promise<void> = Promise.resolve();
  private reloadRequired = false;

  private constructor(
    store: AsyncStateStore<WebhookOutboxState>,
    entries: Map<string, WebhookOutboxEntry>
  ) {
    this.store = store;
    this.entries = entries;
  }

  public static async create(options: {
    store: AsyncStateStore<WebhookOutboxState>;
  }): Promise<WebhookOutboxJournal> {
    const loaded = await options.store.load();
    if (loaded && loaded.state.version !== 1) {
      await options.store.close();
      throw new Error(`Unsupported webhook outbox version: ${String(loaded.state.version)}`);
    }
    const entries = new Map(
      (loaded?.state.deliveries ?? []).map((entry) => [entry.delivery_id, entry])
    );
    return new WebhookOutboxJournal(options.store, entries);
  }

  public async list(): Promise<WebhookOutboxEntry[]> {
    return this.enqueue(async () =>
      [...this.entries.values()].map((entry) => structuredClone(entry))
    );
  }

  public put(entry: WebhookOutboxEntry): Promise<void> {
    const snapshot = structuredClone(entry);
    return this.enqueue(async () => {
      const next = new Map(this.entries);
      next.set(snapshot.delivery_id, snapshot);
      await this.save(next);
    });
  }

  public remove(deliveryId: string): Promise<void> {
    return this.enqueue(async () => {
      if (!this.entries.has(deliveryId)) return;
      const next = new Map(this.entries);
      next.delete(deliveryId);
      await this.save(next);
    });
  }

  public async clear(): Promise<void> {
    await this.enqueue(async () => {
      await this.store.clear();
      this.entries.clear();
    });
  }

  public async close(): Promise<void> {
    await this.tail;
    await this.store.close();
  }

  private async save(next: Map<string, WebhookOutboxEntry>): Promise<void> {
    await this.store.save({ version: 1, deliveries: [...next.values()] });
    this.entries = next;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      // A rejected write may have committed before its acknowledgement was lost.
      // Reconcile from durable storage before reading or replacing another snapshot.
      if (this.reloadRequired) {
        const loaded = await this.store.load();
        if (loaded && loaded.state.version !== 1) {
          throw new Error(`Unsupported webhook outbox version: ${String(loaded.state.version)}`);
        }
        this.entries = new Map(
          (loaded?.state.deliveries ?? []).map((entry) => [entry.delivery_id, entry])
        );
        this.reloadRequired = false;
      }
      try {
        return await operation();
      } catch (error) {
        this.reloadRequired = true;
        throw error;
      }
    });
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
}
