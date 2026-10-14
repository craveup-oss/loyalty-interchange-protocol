import { describe, expect, it } from "vitest";
import { MemoryCloudRepository } from "./memory-repository.js";
import { CloudControlPlane } from "./service.js";
import { startCloudServer } from "./server.js";

describe("Development liveness", () => {
  it("answers /live without querying readiness, database health, or tenant routing", async () => {
    const cloud = new CloudControlPlane({ repository: new MemoryCloudRepository() });
    let ready = true;
    const running = await startCloudServer(cloud, {
      apiKey: "test-key-for-liveness-only",
      port: 0,
      deployment: { environment: "development", release: "test-release" },
      healthCheck: async () => { throw new Error("database probe must not run"); },
      readiness: async () => {
        if (!ready) throw new Error("readiness probe must not run after startup");
        return { ready: true, migrations_applied: true, database_reachable: true,
          provisioning_worker_running: true, expected_runtimes: 0, restored_runtimes: 0 };
      },
      runtimeRequestHandler: async () => { throw new Error("tenant routing must not run"); }
    });
    try {
      ready = false;
      const response = await fetch(`${running.url}/live`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "ok", service: "lip-cloud-control-plane" });
    } finally { await running.close(); }
  });

  it.each(["production", "sandbox", undefined])("does not expose the development probe in %s", async (environment) => {
    const cloud = new CloudControlPlane({ repository: new MemoryCloudRepository() });
    const running = await startCloudServer(cloud, {
      apiKey: "test-key-for-liveness-only",
      port: 0,
      ...(environment ? { deployment: { environment, release: "test-release" } } : {})
    });
    try {
      expect((await fetch(`${running.url}/live`)).status).toBe(404);
    } finally { await running.close(); }
  });

  it("keeps /ready checking real readiness even when development liveness succeeds", async () => {
    let databaseReachable = true;
    const cloud = new CloudControlPlane({ repository: new MemoryCloudRepository() });
    const running = await startCloudServer(cloud, {
      apiKey: "test-key-for-liveness-only",
      port: 0,
      deployment: { environment: "development", release: "test-release" },
      readiness: async () => ({
        ready: databaseReachable, migrations_applied: true, database_reachable: databaseReachable,
        provisioning_worker_running: true, expected_runtimes: 0, restored_runtimes: 0
      })
    });
    try {
      databaseReachable = false;
      expect((await fetch(`${running.url}/live`)).status).toBe(200);
      const readiness = await fetch(`${running.url}/ready`);
      expect(readiness.status).toBe(503);
      expect(await readiness.json()).toMatchObject({ database_reachable: false });
    } finally { await running.close(); }
  });
  it("refuses to listen when managed development startup readiness is incomplete", async () => {
    const cloud = new CloudControlPlane({ repository: new MemoryCloudRepository() });
    const start = startCloudServer(cloud, {
      apiKey: "test-key-for-liveness-only", port: 0,
      deployment: { environment: "development", release: "test-release" },
      readiness: async () => ({ ready: false, migrations_applied: true,
        database_reachable: true, provisioning_worker_running: true,
        expected_runtimes: 1, restored_runtimes: 0 })
    });
    try { await expect(start).rejects.toThrow("startup readiness"); }
    finally { await (await start.catch(() => undefined))?.close(); }
  });

});
