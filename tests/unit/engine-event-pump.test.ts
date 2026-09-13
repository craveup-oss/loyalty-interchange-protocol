import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingEngineEvent } from "@loyalty-interchange/storage-postgres";
import { EngineEventPump } from "../../packages/server/src/engine-event-pump.js";

const pending: PendingEngineEvent = {
  outbox_id: "one", recipients: [{ subscription_id: "sub", url: "https://example.com/hook" }],
  event: {
    specversion: "1.0", lipversion: "1.0", source: "urn:lip:program:test", id: "evt-one",
    type: "org.loyalty-interchange.member.enrolled.v1", subject: "member",
    time: "2026-09-13T00:00:00.000Z", datacontenttype: "application/json",
    data: { member: { member_id: "member", program_id: "test", status: "active",
      joined_at: "2026-09-13T00:00:00.000Z", identities: [] } }
  }
};

describe("single-instance engine event handoff", () => {
  afterEach(() => vi.useRealTimers());

  it("never acknowledges failed admission, retries on the timer and stops on close", async () => {
    vi.useFakeTimers();
    const repository = {
      listPendingEvents: vi.fn().mockResolvedValue([pending]),
      acknowledgeEvent: vi.fn().mockResolvedValue(undefined)
    };
    const dispatcher = { enqueue: vi.fn().mockRejectedValueOnce(new Error("private provider error")).mockResolvedValue(undefined) };
    const onError = vi.fn();
    const pump = new EngineEventPump(repository, dispatcher, onError);
    pump.start();
    await pump.drain();
    expect(repository.acknowledgeEvent).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(repository.acknowledgeEvent).toHaveBeenCalledWith("one");
    await pump.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(dispatcher.enqueue).toHaveBeenCalledTimes(2);
  });

  it("serializes concurrent drains and retries an ambiguous acknowledgement with stable identity", async () => {
    let release!: () => void;
    const repository = {
      listPendingEvents: vi.fn().mockResolvedValue([pending]),
      acknowledgeEvent: vi.fn().mockRejectedValueOnce(new Error("ack lost")).mockResolvedValue(undefined)
    };
    const dispatcher = { enqueue: vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; })).mockResolvedValue(undefined) };
    const pump = new EngineEventPump(repository, dispatcher, vi.fn());
    const first = pump.drain();
    expect(pump.drain()).toBe(first);
    await Promise.resolve();
    release();
    await first;
    await pump.drain();
    expect(dispatcher.enqueue.mock.calls).toEqual([[pending.event, pending.recipients], [pending.event, pending.recipients]]);
    await pump.close();
  });
});
