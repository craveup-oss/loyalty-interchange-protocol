import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AsyncSqliteStateStore } from "@loyalty-interchange/storage-sqlite";
import {
  WebhookHistoryJournal,
  WebhookOutboxJournal,
  WebhookSubscriptionJournal,
  type ManagedWebhookSubscription,
  type WebhookDeliveryArchiveEntry,
  type WebhookHistoryState,
  type WebhookOutboxEntry,
  type WebhookOutboxState,
  type WebhookSubscriptionState
} from "@loyalty-interchange/server";

const makeOutboxEntry = (id: string): WebhookOutboxEntry => ({
  delivery_id: id,
  event: {
    specversion: "1.0",
    id: `event-${id}`,
    source: "urn:lip:test",
    type: "org.loyalty-interchange.member.enrolled.v1",
    time: "2026-07-20T00:00:00.000Z",
    datacontenttype: "application/json",
    data: {}
  } as unknown as WebhookOutboxEntry["event"],
  url: "https://receiver.example/webhooks",
  attempts: 0,
  created_at: "2026-07-20T00:00:00.000Z",
  updated_at: "2026-07-20T00:00:00.000Z"
});

describe("async webhook stores", () => {
  const cleanups: Array<() => void> = [];

  const tempPath = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "lip-webhook-stores-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return join(dir, "state.db");
  };

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  it("outbox persists puts and removes across reopen", async () => {
    const path = tempPath();
    const outbox = await WebhookOutboxJournal.create({ store: new AsyncSqliteStateStore<WebhookOutboxState>({ path, key: "demo:webhook-outbox" }) });
    await outbox.put(makeOutboxEntry("a"));
    await outbox.put(makeOutboxEntry("b"));
    await outbox.remove("a");
    expect((await outbox.list()).map((entry: WebhookOutboxEntry) => entry.delivery_id)).toEqual(["b"]);
    await outbox.close();

    const reopened = await WebhookOutboxJournal.create({ store: new AsyncSqliteStateStore<WebhookOutboxState>({ path, key: "demo:webhook-outbox" }) });
    expect((await reopened.list()).map((entry: WebhookOutboxEntry) => entry.delivery_id)).toEqual(["b"]);
    await reopened.close();
  });

  it("outbox preserves the order of un-awaited writes", async () => {
    const path = tempPath();
    const outbox = await WebhookOutboxJournal.create({ store: new AsyncSqliteStateStore<WebhookOutboxState>({ path, key: "demo:webhook-outbox" }) });
    void outbox.put(makeOutboxEntry("first"));
    void outbox.put(makeOutboxEntry("second"));
    void outbox.remove("first");
    await outbox.close();

    const reopened = await WebhookOutboxJournal.create({ store: new AsyncSqliteStateStore<WebhookOutboxState>({ path, key: "demo:webhook-outbox" }) });
    expect((await reopened.list()).map((entry: WebhookOutboxEntry) => entry.delivery_id)).toEqual(["second"]);
    await reopened.close();
  });

  it("history round-trips archive entries", async () => {
    const path = tempPath();
    const history = new WebhookHistoryJournal({ store: new AsyncSqliteStateStore<WebhookHistoryState>({ path, key: "demo:webhook-history" }) });
    const entry: WebhookDeliveryArchiveEntry = {
      ...makeOutboxEntry("archived"),
      event_id: "event-archived",
      event_type: "org.loyalty-interchange.member.enrolled.v1",
      attempts: 1,
      status: "delivered",
      completed_at: "2026-07-20T00:00:01.000Z"
    };
    await history.save([entry]);
    await history.close();

    const reopened = new WebhookHistoryJournal({ store: new AsyncSqliteStateStore<WebhookHistoryState>({ path, key: "demo:webhook-history" }) });
    expect((await reopened.list()).map(({ delivery_id }) => delivery_id)).toEqual(["archived"]);
    await reopened.close();
  });

  it("retains a failed removal in memory and persists a successful retry", async () => {
    const store = new AsyncSqliteStateStore<WebhookOutboxState>({ path: tempPath(), key: "outbox" });
    const outbox = await WebhookOutboxJournal.create({ store });
    try {
      await outbox.put(makeOutboxEntry("retry"));
      vi.spyOn(store, "save").mockRejectedValueOnce(new Error("disk unavailable"));
      await expect(outbox.remove("retry")).rejects.toThrow("disk unavailable");
      expect((await outbox.list()).map((entry) => entry.delivery_id)).toEqual(["retry"]);
      await outbox.remove("retry");
      expect((await store.load())?.state.deliveries).toEqual([]);
    } finally {
      await outbox.close();
    }
  });

  it("does not leak a failed put into a later successful snapshot", async () => {
    const store = new AsyncSqliteStateStore<WebhookOutboxState>({ path: tempPath(), key: "outbox" });
    const outbox = await WebhookOutboxJournal.create({ store });
    try {
      vi.spyOn(store, "save").mockRejectedValueOnce(new Error("disk unavailable"));
      await expect(outbox.put(makeOutboxEntry("failed"))).rejects.toThrow("disk unavailable");
      expect(await outbox.list()).toEqual([]);
      await outbox.put(makeOutboxEntry("accepted"));
      expect((await store.load())?.state.deliveries.map((entry) => entry.delivery_id)).toEqual(["accepted"]);
    } finally {
      await outbox.close();
    }
  });

  it("retains pending entries if clearing durable storage fails", async () => {
    const store = new AsyncSqliteStateStore<WebhookOutboxState>({ path: tempPath(), key: "outbox" });
    const outbox = await WebhookOutboxJournal.create({ store });
    try {
      await outbox.put(makeOutboxEntry("retained"));
      vi.spyOn(store, "clear").mockRejectedValueOnce(new Error("disk unavailable"));
      await expect(outbox.clear()).rejects.toThrow("disk unavailable");
      expect((await outbox.list()).map((entry) => entry.delivery_id)).toEqual(["retained"]);
      await outbox.clear();
      expect(await outbox.list()).toEqual([]);
      expect(await store.load()).toBeNull();
    } finally {
      await outbox.close();
    }
  });

  it("serializes a delayed clear before a later put", async () => {
    const store = new AsyncSqliteStateStore<WebhookOutboxState>({ path: tempPath(), key: "outbox" });
    const outbox = await WebhookOutboxJournal.create({ store });
    let releaseClear!: () => void;
    let startClear!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseClear = resolve; });
    const started = new Promise<void>((resolve) => { startClear = resolve; });
    const pending: Promise<void>[] = [];
    try {
      await outbox.put(makeOutboxEntry("before"));
      const clearStore = store.clear.bind(store);
      vi.spyOn(store, "clear").mockImplementationOnce(async () => {
        startClear();
        await blocked;
        await clearStore();
      });
      pending.push(outbox.clear());
      await started;
      pending.push(outbox.put(makeOutboxEntry("after")));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect((await store.load())?.state.deliveries.map((entry) => entry.delivery_id)).toEqual(["before"]);
      releaseClear();
      await Promise.all(pending);
      expect((await outbox.list()).map((entry) => entry.delivery_id)).toEqual(["after"]);
      expect((await store.load())?.state.deliveries.map((entry) => entry.delivery_id)).toEqual(["after"]);
    } finally {
      releaseClear();
      await Promise.allSettled(pending);
      await outbox.close();
    }
  });

  it("snapshots an entry when admitted rather than when its queued save runs", async () => {
    const store = new AsyncSqliteStateStore<WebhookOutboxState>({ path: tempPath(), key: "outbox" });
    const outbox = await WebhookOutboxJournal.create({ store });
    try {
      const entry = makeOutboxEntry("original");
      const write = outbox.put(entry);
      entry.event.id = "caller-mutated";
      await write;
      expect((await store.load())?.state.deliveries[0]?.event.id).toBe("event-original");
      const listed = await outbox.list();
      listed[0]!.event.id = "reader-mutated";
      expect((await outbox.list())[0]?.event.id).toBe("event-original");
    } finally {
      await outbox.close();
    }
  });

  it("reconciles a committed put whose acknowledgement was lost before another write", async () => {
    const store = new AsyncSqliteStateStore<WebhookOutboxState>({ path: tempPath(), key: "outbox" });
    const outbox = await WebhookOutboxJournal.create({ store });
    try {
      const save = store.save.bind(store);
      vi.spyOn(store, "save").mockImplementationOnce(async (state) => {
        await save(state);
        throw new Error("acknowledgement lost");
      });
      await expect(outbox.put(makeOutboxEntry("committed"))).rejects.toThrow("acknowledgement lost");
      await outbox.put(makeOutboxEntry("later"));
      expect((await store.load())?.state.deliveries.map((entry) => entry.delivery_id)).toEqual(["committed", "later"]);
    } finally {
      await outbox.close();
    }
  });

  it("blocks later writes until an ambiguous failure can be reloaded", async () => {
    const store = new AsyncSqliteStateStore<WebhookOutboxState>({ path: tempPath(), key: "outbox" });
    const outbox = await WebhookOutboxJournal.create({ store });
    try {
      vi.spyOn(store, "save").mockRejectedValueOnce(new Error("write unavailable"));
      await expect(outbox.put(makeOutboxEntry("failed"))).rejects.toThrow("write unavailable");
      vi.spyOn(store, "load").mockRejectedValueOnce(new Error("read unavailable"));
      await expect(outbox.put(makeOutboxEntry("blocked"))).rejects.toThrow("read unavailable");
      expect(await store.load()).toBeNull();
      await outbox.put(makeOutboxEntry("recovered"));
      expect((await outbox.list()).map((entry) => entry.delivery_id)).toEqual(["recovered"]);
    } finally {
      await outbox.close();
    }
  });

  it("does not resurrect entries after a committed clear loses its acknowledgement", async () => {
    const store = new AsyncSqliteStateStore<WebhookOutboxState>({ path: tempPath(), key: "outbox" });
    const outbox = await WebhookOutboxJournal.create({ store });
    try {
      await outbox.put(makeOutboxEntry("cleared"));
      const clear = store.clear.bind(store);
      vi.spyOn(store, "clear").mockImplementationOnce(async () => {
        await clear();
        throw new Error("acknowledgement lost");
      });
      await expect(outbox.clear()).rejects.toThrow("acknowledgement lost");
      await outbox.put(makeOutboxEntry("later"));
      expect((await store.load())?.state.deliveries.map((entry) => entry.delivery_id)).toEqual(["later"]);
    } finally {
      await outbox.close();
    }
  });

  it("subscription store round-trips subscriptions and reports absence as undefined", async () => {
    const path = tempPath();
    const store = new WebhookSubscriptionJournal({ store: new AsyncSqliteStateStore<WebhookSubscriptionState>({ path, key: "demo:webhook-subscriptions" }) });
    expect(await store.load()).toBeUndefined();
    const subscription: ManagedWebhookSubscription = {
      subscription_id: "webhook_test",
      url: "https://receiver.example/webhooks",
      secret: "super-secret-value-123",
      active: true
    };
    await store.save([subscription]);
    await store.close();

    const reopened = new WebhookSubscriptionJournal({ store: new AsyncSqliteStateStore<WebhookSubscriptionState>({ path, key: "demo:webhook-subscriptions" }) });
    expect((await reopened.load())?.map(({ subscription_id }) => subscription_id)).toEqual(["webhook_test"]);
    await reopened.close();
  });
});
