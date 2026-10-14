import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryCloudRepository } from "./memory-repository.js";
import { CloudProvisioningWorker, provisioningPollingOptions, type CloudProvisioner } from "./provisioning.js";
import { CloudControlPlane } from "./service.js";

const owner = { issuer: "https://identity.example.com", subject: "owner" };
const workers: CloudProvisioningWorker[] = [];

class CountingRepository extends MemoryCloudRepository {
  claims = 0;
  override async claimProvisioningJob(workerId: string, leaseSeconds: number) {
    this.claims += 1;
    return super.claimProvisioningJob(workerId, leaseSeconds);
  }
}

async function fixture(
  provision?: CloudProvisioner["provision"],
  repository = new CountingRepository(),
  deploymentEnvironment: string | undefined = "development"
) {
  let worker: CloudProvisioningWorker | undefined;
  const cloud = new CloudControlPlane({
    repository,
    onProvisioningJobCreated: () => worker?.wake()
  });
  const dashboard = await cloud.createOrganization(owner, { name: "Test", slug: "test-org" });
  const project = await cloud.createProject(owner, dashboard.organization.organization_id, {
    name: "Test", slug: "test-project"
  });
  worker = new CloudProvisioningWorker({
    repository,
    workerId: "test-worker",
    onError: () => undefined,
    ...provisioningPollingOptions(deploymentEnvironment),
    provisioner: {
      provision: provision ?? (async () => ({ api_url: "https://loyalty.example.com" }))
    }
  });
  workers.push(worker);
  const create = (slug: string) => cloud.createEnvironment(owner, project.project_id, {
    name: slug, slug, kind: "development", region: "us-east-1", program_id: "test-rewards"
  });
  return { worker, cloud, repository, create, project };
}

afterEach(() => {
  for (const worker of workers.splice(0)) worker.close();
  vi.useRealTimers();
});

describe("Provisioning idle scheduling", () => {
  it("does not claim an empty queue again until 30 minutes have elapsed", async () => {
    vi.useFakeTimers();
    const { worker, repository } = await fixture();
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(repository.claims).toBe(1);
    await vi.advanceTimersByTimeAsync(1_799_999);
    expect(repository.claims).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(repository.claims).toBe(2);
  });

  it("provisions a newly committed job immediately while the worker is idle", async () => {
    vi.useFakeTimers();
    const { worker, repository, create } = await fixture();
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    const environment = await create("new-environment");
    await vi.advanceTimersByTimeAsync(0);
    expect(await repository.environmentById(environment.environment_id)).toMatchObject({ status: "ready" });
  });

  it("keeps draining queued jobs at the fast cadence before returning to idle", async () => {
    vi.useFakeTimers();
    const { worker, repository, create } = await fixture();
    const first = await create("first-environment");
    const second = await create("second-environment");
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(await repository.environmentById(first.environment_id)).toMatchObject({ status: "ready" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await repository.environmentById(second.environment_id)).toMatchObject({ status: "ready" });
    await vi.advanceTimersByTimeAsync(5_000);
    const idleClaims = repository.claims;
    await vi.advanceTimersByTimeAsync(1_799_999);
    expect(repository.claims).toBe(idleClaims);
  });

  it("does not lose a wake received while another provisioning job is running", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let active = 0;
    let maximumActive = 0;
    const { worker, repository, create } = await fixture(async ({ environment }) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (environment.slug === "first-environment") await blocked;
      active -= 1;
      return { api_url: "https://loyalty.example.com" };
    });
    await create("first-environment");
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    const second = await create("second-environment");
    release!();
    await vi.advanceTimersByTimeAsync(0);
    expect(await repository.environmentById(second.environment_id)).toMatchObject({ status: "ready" });
    expect(maximumActive).toBe(1);
  });

  it("does not sleep for 30 minutes between a failed attempt and its retry", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const { worker, repository, create } = await fixture(async () => {
      if (++attempts < 3) throw new Error("temporary failure");
      return { api_url: "https://loyalty.example.com" };
    });
    const environment = await create("retry-environment");
    worker.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await repository.environmentById(environment.environment_id)).toMatchObject({ status: "ready" });
  });

  it("does not wake before the environment and job are committed", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const committed = new Promise<void>((resolve) => { release = resolve; });
    class DelayedRepository extends CountingRepository {
      override async createEnvironment(...args: Parameters<MemoryCloudRepository["createEnvironment"]>) {
        await committed;
        await super.createEnvironment(...args);
      }
    }
    const { worker, repository, create } = await fixture(undefined, new DelayedRepository());
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    const pending = create("commit-environment");
    await vi.advanceTimersByTimeAsync(0);
    expect(repository.claims).toBe(1);
    release!();
    const environment = await pending;
    await vi.advanceTimersByTimeAsync(0);
    expect(await repository.environmentById(environment.environment_id)).toMatchObject({ status: "ready" });
  });

  it("recovers a durable job on restart without waiting for the idle timer", async () => {
    vi.useFakeTimers();
    const { worker, repository, create } = await fixture();
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    worker.close();
    const environment = await create("restart-environment");
    await vi.advanceTimersByTimeAsync(0);
    expect(await repository.environmentById(environment.environment_id)).toMatchObject({ status: "pending" });
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(await repository.environmentById(environment.environment_id)).toMatchObject({ status: "ready" });
  });

  it("stops all scheduled claims after close", async () => {
    vi.useFakeTimers();
    const { worker, repository } = await fixture();
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    worker.close();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(repository.claims).toBe(1);
  });

  it.each(["production", "sandbox", "", "dev"])("keeps the five-second empty-queue cadence for %s", async (environment) => {
    vi.useFakeTimers();
    const { worker, repository } = await fixture(undefined, new CountingRepository(), environment);
    worker.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(repository.claims).toBe(2);
  });

  it("recovers a previously claimed job as soon as its lease expires", async () => {
    vi.useFakeTimers();
    const { worker, repository, create } = await fixture();
    const environment = await create("leased-environment");
    await repository.claimProvisioningJob("old-worker", 60);
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(await repository.environmentById(environment.environment_id)).toMatchObject({ status: "provisioning" });
    await vi.advanceTimersByTimeAsync(65_000);
    expect(await repository.environmentById(environment.environment_id)).toMatchObject({ status: "ready" });
  });

  it("honors a durable retry timestamp across worker restart", async () => {
    vi.useFakeTimers();
    const { worker, repository, create } = await fixture();
    const environment = await create("durable-retry-environment");
    const job = await repository.claimProvisioningJob("old-worker", 60);
    await repository.failProvisioningJob(job!.provisioning_job_id, "retry later", new Date(Date.now() + 60_000).toISOString());
    worker.start();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(await repository.environmentById(environment.environment_id)).toMatchObject({ status: "pending" });
    await vi.advanceTimersByTimeAsync(1);
    expect(await repository.environmentById(environment.environment_id)).toMatchObject({ status: "ready" });
  });

  it("does not wake for a rejected environment commit", async () => {
    vi.useFakeTimers();
    class RejectedRepository extends CountingRepository {
      override async createEnvironment() { throw new Error("commit rejected"); }
    }
    const { worker, repository, create } = await fixture(undefined, new RejectedRepository());
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    await expect(create("rejected-environment")).rejects.toThrow("commit rejected");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(repository.claims).toBe(1);
  });

  it("retries a transient claim error promptly instead of entering the idle sleep", async () => {
    vi.useFakeTimers();
    class InterruptedRepository extends CountingRepository {
      interrupted = true;
      override async claimProvisioningJob(workerId: string, leaseSeconds: number) {
        if (this.interrupted) { this.interrupted = false; throw new Error("connection interrupted"); }
        return super.claimProvisioningJob(workerId, leaseSeconds);
      }
    }
    const { worker, repository, create } = await fixture(undefined, new InterruptedRepository());
    const environment = await create("reconnect-environment");
    worker.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await repository.environmentById(environment.environment_id)).toMatchObject({ status: "ready" });
  });

  it("does not lose a wake that races an empty claim", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    class RacingRepository extends CountingRepository {
      blocking = true;
      override async claimProvisioningJob(workerId: string, leaseSeconds: number) {
        const job = await super.claimProvisioningJob(workerId, leaseSeconds);
        if (this.blocking) { this.blocking = false; await blocked; }
        return job;
      }
    }
    const { worker, repository, create } = await fixture(undefined, new RacingRepository());
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    const environment = await create("racing-environment");
    release!();
    await vi.advanceTimersByTimeAsync(0);
    expect(await repository.environmentById(environment.environment_id)).toMatchObject({ status: "ready" });
  });

  it("does not restart polling after close during an in-flight provision", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const { worker, repository, create } = await fixture(async () => {
      await blocked;
      return { api_url: "https://loyalty.example.com" };
    });
    await create("closing-environment");
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    worker.close();
    release!();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(repository.claims).toBe(1);
  });

  it("keeps a committed job recoverable when its local wake callback throws", async () => {
    vi.useFakeTimers();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { worker, repository, project } = await fixture();
      const cloud = new CloudControlPlane({
        repository, onProvisioningJobCreated: () => { throw new Error("local wake interrupted"); }
      });
      worker.start();
      await vi.advanceTimersByTimeAsync(0);
      const environment = await cloud.createEnvironment(owner, project.project_id, {
        name: "Test", slug: "failed-wake-environment", kind: "development", region: "us-east-1", program_id: "test-rewards"
      });
      expect(await repository.environmentById(environment.environment_id)).toMatchObject({ status: "pending" });
      await vi.advanceTimersByTimeAsync(1_800_000);
      expect(await repository.environmentById(environment.environment_id)).toMatchObject({ status: "ready" });
    } finally { errorLog.mockRestore(); }
  });
});
