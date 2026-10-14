import type {
  CloudEnvironment,
  CloudProvisioningJob,
  CloudProvisioningResult,
  CloudRepository
} from "./types.js";

export interface CloudProvisioner {
  provision(input: {
    environment: CloudEnvironment;
    job: CloudProvisioningJob;
  }): Promise<CloudProvisioningResult>;
}

export interface CloudProvisioningWorkerOptions {
  repository: CloudRepository;
  provisioner: CloudProvisioner;
  workerId: string;
  leaseSeconds?: number;
  pollIntervalMs?: number;
  idlePollIntervalMs?: number;
  onError?: (error: unknown) => void;
}

/** Only the managed development deployment opts into long idle sleeps. */
export function provisioningPollingOptions(environment: string | undefined): Pick<
  CloudProvisioningWorkerOptions, "idlePollIntervalMs"
> {
  return environment === "development" ? { idlePollIntervalMs: 30 * 60 * 1_000 } : {};
}

export class CloudProvisioningWorker {
  private readonly repository: CloudRepository;
  private readonly provisioner: CloudProvisioner;
  private readonly workerId: string;
  private readonly leaseSeconds: number;
  private readonly pollIntervalMs: number;
  private readonly idlePollIntervalMs: number;
  private readonly onError: (error: unknown) => void;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private started = false;
  private cycleInFlight = false;
  private wakeRequested = false;
  private nextJobAt: number | undefined;

  public constructor(options: CloudProvisioningWorkerOptions) {
    if (!options.workerId.trim()) throw new Error("Provisioning worker id is required");
    this.repository = options.repository;
    this.provisioner = options.provisioner;
    this.workerId = options.workerId;
    this.leaseSeconds = options.leaseSeconds ?? 60;
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.idlePollIntervalMs = options.idlePollIntervalMs ?? this.pollIntervalMs;
    for (const interval of [this.pollIntervalMs, this.idlePollIntervalMs]) {
      if (!Number.isSafeInteger(interval) || interval < 1 || interval > 2_147_483_647) {
        throw new Error("Provisioning poll intervals must be positive timer-safe integers");
      }
    }
    this.onError = options.onError ?? ((error) => console.error("[lip-cloud] provisioning failed", error));
  }

  public start(): void {
    if (this.started) return;
    this.started = true;
    this.wake();
  }

  /** Called after a job is durably enqueued; never runs parallel claim cycles. */
  public wake(): void {
    if (!this.started) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.wakeRequested = true;
    if (!this.cycleInFlight) void this.tick();
  }

  private async tick(): Promise<void> {
    if (!this.started || this.cycleInFlight) return;
    this.cycleInFlight = true;
    this.wakeRequested = false;
    let delay = this.pollIntervalMs;
    try {
      const result = await this.runOnce();
      // Future retries and unexpired claims survive process restarts. Wake at
      // the durable deadline rather than treating them as an empty queue.
      if (result === "idle") {
        delay = this.nextJobAt === undefined ? this.idlePollIntervalMs
          : Math.min(this.idlePollIntervalMs, Math.max(this.pollIntervalMs, this.nextJobAt - Date.now()));
      }
    } catch (error) {
      this.onError(error);
    } finally {
      this.cycleInFlight = false;
      if (this.started) {
        if (this.wakeRequested) {
          // An enqueue can race the empty claim or an in-flight provision.
          // Preserve that wake instead of entering the long idle sleep.
          queueMicrotask(() => void this.tick());
        } else {
          this.timer = setTimeout(() => void this.tick(), delay);
          this.timer.unref();
        }
      }
    }
  }

  public async runOnce(): Promise<"idle" | "succeeded" | "retrying" | "failed"> {
    if (this.running) return "idle";
    this.running = true;
    try {
      const job = await this.repository.claimProvisioningJob(
        this.workerId,
        this.leaseSeconds
      );
      if (!job) {
        if (this.idlePollIntervalMs > this.pollIntervalMs) {
          const next = await this.repository.nextProvisioningJobAt();
          this.nextJobAt = next ? Date.parse(next) : undefined;
        }
        return "idle";
      }
      const environment = await this.repository.environmentById(job.environment_id);
      if (!environment) {
        await this.repository.failProvisioningJob(
          job.provisioning_job_id,
          "Provisioning environment was not found"
        );
        return "failed";
      }
      try {
        const result = await this.provisioner.provision({ environment, job });
        await this.repository.completeProvisioningJob(
          job.provisioning_job_id,
          result
        );
        return "succeeded";
      } catch (error) {
        const message = error instanceof Error ? error.message : "Provisioning failed";
        const exhausted = job.attempts >= 5;
        const retryAt = exhausted
          ? undefined
          : new Date(
              Date.now() + Math.min(300_000, 2 ** job.attempts * 1_000)
            ).toISOString();
        await this.repository.failProvisioningJob(
          job.provisioning_job_id,
          message,
          retryAt
        );
        this.onError(error);
        return exhausted ? "failed" : "retrying";
      }
    } finally {
      this.running = false;
    }
  }

  public close(): void {
    this.started = false;
    this.wakeRequested = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
