import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresCloudRepository } from "./postgres-repository.js";
import { CloudControlPlane } from "./service.js";

const postgresUrl = process.env["LIP_TEST_POSTGRES_URL"];
const postgresDescribe = postgresUrl ? describe : describe.skip;

postgresDescribe("Durable provisioning deadlines", () => {
  it("reports pending retry and running lease deadlines without claiming future work", async () => {
    const schema = `provisioning_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: postgresUrl! });
    const pool = new Pool({ connectionString: postgresUrl!, options: `-c search_path=${schema}` });
    const repository = new PostgresCloudRepository({ pool });
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      await repository.migrate();
      expect(await repository.nextProvisioningJobAt()).toBeUndefined();
      const principal = { issuer: "https://identity.example.com", subject: "test-owner" };
      const cloud = new CloudControlPlane({ repository });
      const organization = await cloud.createOrganization(principal, { name: "Test", slug: "test-org" });
      const project = await cloud.createProject(principal, organization.organization.organization_id, {
        name: "Test", slug: "test-project"
      });
      await cloud.createEnvironment(principal, project.project_id, {
        name: "Test", slug: "test-environment", kind: "development", region: "us-east-1", program_id: "test-rewards"
      });
      expect(Date.parse((await repository.nextProvisioningJobAt())!)).toBeLessThanOrEqual(Date.now());
      const job = await repository.claimProvisioningJob("worker-test", 60);
      expect(job).toBeDefined();
      expect(await repository.nextProvisioningJobAt()).toBe(job!.claimed_until);
      expect(await repository.claimProvisioningJob("other-worker", 60)).toBeUndefined();
      const retryAt = new Date(Date.now() + 60_000).toISOString();
      await repository.failProvisioningJob(job!.provisioning_job_id, "retry later", retryAt);
      expect(await repository.nextProvisioningJobAt()).toBe(retryAt);
      expect(await repository.claimProvisioningJob("worker-test", 60)).toBeUndefined();
      await pool.query("UPDATE lip_cloud_provisioning_jobs SET available_at = now() - interval '1 second'");
      const due = await repository.claimProvisioningJob("worker-test", 60);
      expect(due?.provisioning_job_id).toBe(job!.provisioning_job_id);
      await repository.completeProvisioningJob(due!.provisioning_job_id, { api_url: "https://loyalty.example.com" });
      expect(await repository.nextProvisioningJobAt()).toBeUndefined();
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });
});
