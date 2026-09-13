import { describe, expect, it } from "vitest";
import { MemoryCloudRepository } from "./memory-repository.js";
import { PostgresCloudRepository } from "./postgres-repository.js";
import type { CloudPlan } from "./types.js";

function commercialShape(plan: CloudPlan) {
  const { created_at: _created, updated_at: _updated, ...commercial } = plan;
  return commercial;
}

it("offers all maintained cloud plans in the in-memory control plane", async () => {
  const repository = new MemoryCloudRepository();
  expect((await repository.plans()).map((plan) => plan.plan_id).sort())
    .toEqual(["business", "free", "pro"]);
  expect(await repository.planById("business")).toMatchObject({
    monthly_price_minor: 39900,
    currency: "USD",
    active: true
  });
});

const postgresUrl = process.env["LIP_TEST_POSTGRES_URL"];
describe.skipIf(!postgresUrl)("plan catalogue against disposable Postgres", () => {
  it("keeps SQL seed and in-memory prices and limits identical", async () => {
    const postgres = new PostgresCloudRepository({ connectionString: postgresUrl! });
    try {
      await postgres.migrate();
      const expected = (await new MemoryCloudRepository().plans())
        .map(commercialShape).sort((a, b) => a.plan_id.localeCompare(b.plan_id));
      const actual = (await postgres.plans())
        .map(commercialShape).sort((a, b) => a.plan_id.localeCompare(b.plan_id));
      expect(actual).toEqual(expected);
    } finally {
      await postgres.close();
    }
  });
});
