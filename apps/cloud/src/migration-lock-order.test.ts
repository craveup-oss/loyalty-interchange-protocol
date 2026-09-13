import { expect, it } from "vitest";
import type { Pool } from "pg";
import { PostgresMigrator } from "@loyalty-interchange/storage-postgres";
import { PostgresCloudRepository } from "./postgres-repository.js";

it.each(["engine", "cloud"])("locks before even the %s migration-table bootstrap", async (kind) => {
  const queries: string[] = [];
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [] };
    },
    release: () => undefined
  };
  const pool = { connect: async () => client } as unknown as Pool;
  const migrator = kind === "engine"
    ? new PostgresMigrator(pool)
    : new PostgresCloudRepository({ pool });
  await migrator.migrate();
  const lock = queries.findIndex((sql) => sql.includes("pg_advisory_xact_lock"));
  const ddl = queries.findIndex((sql) => sql.includes("CREATE TABLE"));
  expect(lock).toBeGreaterThan(-1);
  expect(ddl).toBeGreaterThan(lock);
});
