import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import type { LoyaltyEvent } from "@loyalty-interchange/protocol";
import { LoyaltyEngine } from "@loyalty-interchange/reference";
import { PostgresEngineRepository, withTenantTransaction } from "@loyalty-interchange/storage-postgres";
import { makeEnroll, makeProgram, sequentialIds } from "../fixtures.js";

const pgDescribe = process.env["LIP_TEST_POSTGRES_URL"] ? describe : describe.skip;

pgDescribe("transactional engine event outbox", () => {
  async function fixture() {
    const pool = new Pool({ connectionString: process.env["LIP_TEST_POSTGRES_URL"] });
    const tenantId = `event-${randomUUID()}`;
    const program = makeProgram();
    const repo = new PostgresEngineRepository({ pool, tenantId, programId: program.program_id });
    await repo.migrate();
    const engine = new LoyaltyEngine(program, { ids: sequentialIds() });
    const event: LoyaltyEvent = {
      specversion: "1.0", id: "evt-one", source: `urn:lip:program:${program.program_id}`,
      type: "org.loyalty-interchange.member.enrolled.v1", subject: "member-001",
      time: "2026-09-13T00:00:00.000Z", datacontenttype: "application/json", lipversion: "1.0",
      data: { member: { member_id: "member-001", program_id: program.program_id, status: "active",
        joined_at: "2026-09-13T00:00:00.000Z", identities: [] } }
    };
    const pending = { event, recipients: [{ subscription_id: "sub-one", url: "https://example.com/hook" }] };
    return { pool, repo, engine, tenantId, program, pending };
  }

  it("commits both owners, survives repository restart, preserves the first pending envelope and fences acknowledgements", async () => {
    const f = await fixture();
    try {
      await f.repo.mutate(f.engine, () => f.engine.enroll(makeEnroll("event-enroll")), () => [f.pending]);
      const restarted = new PostgresEngineRepository({ pool: f.pool, tenantId: f.tenantId, programId: f.program.program_id });
      expect((await restarted.load())?.state.members).toHaveLength(1);
      const [first] = await restarted.listPendingEvents();
      expect(first).toMatchObject(f.pending);
      await restarted.mutate(f.engine, () => undefined, () => [{ ...f.pending, event: { ...f.pending.event, time: "2026-09-14T00:00:00.000Z" } }]);
      expect(await restarted.listPendingEvents()).toEqual([first]);
      await restarted.acknowledgeEvent(first!.outbox_id);
      await restarted.mutate(f.engine, () => undefined, () => [f.pending]);
      await restarted.acknowledgeEvent(first!.outbox_id);
      expect(await restarted.listPendingEvents()).toHaveLength(1);
    } finally { await f.pool.end(); }
  });

  it("rolls back the engine if event persistence fails", async () => {
    const f = await fixture();
    try {
      await expect(f.repo.mutate(f.engine, () => f.engine.enroll(makeEnroll("rollback-event")), () => [
        { ...f.pending, recipients: [] }
      ])).rejects.toThrow();
      expect(await f.repo.load()).toBeNull();
      expect(await f.repo.listPendingEvents()).toEqual([]);
      expect(f.engine.exportState().members).toEqual([]);
    } finally { await f.pool.end(); }
  });

  it("enforces RLS without relying on a query predicate and denies another tenant's acknowledgement", async () => {
    const f = await fixture();
    try {
      await f.repo.mutate(f.engine, () => f.engine.enroll(makeEnroll("isolated-event")), () => [f.pending]);
      const [pending] = await f.repo.listPendingEvents();
      const other = new PostgresEngineRepository({ pool: f.pool, tenantId: `other-${randomUUID()}`, programId: f.program.program_id });
      await other.acknowledgeEvent(pending!.outbox_id);
      expect(await f.repo.listPendingEvents()).toHaveLength(1);
      await withTenantTransaction(f.pool, `other-${randomUUID()}`, async (client) => {
        expect((await client.query("SELECT * FROM lip_engine_event_outbox")).rows).toEqual([]);
      });
    } finally { await f.pool.end(); }
  });

  it("purges an erased member's pending source payload in the engine transaction and cascades reset", async () => {
    const f = await fixture();
    try {
      await f.repo.mutate(f.engine, () => f.engine.enroll(makeEnroll("erase-event")), () => [f.pending]);
      await f.repo.mutate(f.engine, () => f.engine.eraseMember("member-001"));
      expect(await f.repo.listPendingEvents()).toEqual([]);
      await f.repo.mutate(f.engine, () => undefined, () => [{ ...f.pending, event: { ...f.pending.event, subject: "other" } }]);
      await f.repo.clear();
      expect(await f.repo.listPendingEvents()).toEqual([]);
    } finally { await f.pool.end(); }
  });
});
