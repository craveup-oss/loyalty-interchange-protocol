import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { MemoryCloudRepository } from "./memory-repository.js";
import { CloudControlPlane } from "./service.js";
import { startCloudServer } from "./server.js";

const owner = { issuer: "https://identity.example.test", subject: "brand-a-owner" };
const foreign = { issuer: owner.issuer, subject: "brand-b-owner" };

// This matrix deliberately uses valid requests: a validation error or a route
// miss must never count as evidence that membership was enforced.
function routes(org: string, project: string, environment: string) {
  const organization = `/cloud/v1/organizations/${org}`;
  const env = `/cloud/v1/environments/${environment}`;
  return [
    { handler: "dashboard", method: "GET", path: organization },
    { handler: "projects", method: "GET", path: `${organization}/projects` },
    { handler: "members", method: "GET", path: `${organization}/members` },
    {
      handler: "createBillingCheckout",
      method: "POST",
      path: `${organization}/billing/checkout`,
      body: { plan_id: "business", return_url: "https://dashboard.example.test" }
    },
    {
      handler: "cancelBillingSubscription",
      method: "POST",
      path: `${organization}/billing/cancel`
    },
    {
      handler: "createProject",
      method: "POST",
      path: `${organization}/projects`,
      body: { name: "New project", slug: "new-project" }
    },
    {
      handler: "updateMember",
      method: "PATCH",
      path: `${organization}/members`,
      body: { issuer: owner.issuer, subject: owner.subject, role: "admin" }
    },
    {
      handler: "inviteMember",
      method: "POST",
      path: `${organization}/invitations`,
      body: { email: "invited@example.test", role: "admin" }
    },
    { handler: "environments", method: "GET", path: `/cloud/v1/projects/${project}/environments` },
    {
      handler: "createEnvironment",
      method: "POST",
      path: `/cloud/v1/projects/${project}/environments`,
      body: {
        name: "Sandbox",
        slug: "sandbox",
        kind: "staging",
        region: "us-east-1",
        program_id: "sandbox-program"
      }
    },
    {
      handler: "attachEnvironment",
      method: "POST",
      path: `${env}/attach`,
      body: { endpoint_url: "https://engine.example.test", api_key: "not-a-real-key" }
    },
    {
      handler: "rotateEnvironmentCredentials",
      method: "POST",
      path: `${env}/credentials/rotate`,
      body: { overlap_seconds: 0 }
    },
    ...["suspend", "resume", "backup", "restore"].map((operation) => ({
      handler: "operateLocalEnvironment",
      method: "POST",
      path: `${env}/operations/${operation}`,
      body: { backup_id: "backup-test" }
    })),
    {
      handler: "recordUsage",
      method: "POST",
      path: `${env}/usage-events`,
      body: { metric: "messages", quantity: 1, idempotency_key: "usage-isolation-test" }
    },
    { handler: "usage", method: "GET", path: `${env}/usage` }
  ];
}

describe("control-plane route membership inventory", () => {
  it("requires every mounted control-plane handler to have an explicit authorization disposition", () => {
    const source = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
    const mounted = [
      ...new Set([...source.matchAll(/controlPlane\.(\w+)\(/g)].map((match) => match[1]))
    ].sort();
    // These are not existing-tenant reads/writes: plans are shared, organizations
    // filters the caller's memberships, creation establishes ownership,
    // invitations prove their own secret, billing webhooks verify a signature.
    const separateAuthority = [
      "plans",
      "organizations",
      "createOrganization",
      "acceptInvitation",
      "applyBillingWebhook"
    ];
    expect(mounted).toEqual(
      [
        ...new Set([
          ...routes("org", "project", "env").map((route) => route.handler),
          ...separateAuthority
        ])
      ].sort()
    );
  });

  it.each(["member", "inactive-member", "scoped-operator"] as const)(
    "denies all foreign-tenant routes before effects for a %s",
    async (kind) => {
      const repository = new MemoryCloudRepository();
      const cloud = new CloudControlPlane({ repository });
      const brandA = await cloud.createOrganization(owner, { name: "Brand A", slug: "brand-a" });
      const brandB = await cloud.createOrganization(foreign, { name: "Brand B", slug: "brand-b" });
      const org = brandA.organization.organization_id;
      const project = await cloud.createProject(owner, org, { name: "Loyalty", slug: "loyalty" });
      const environment = await cloud.createEnvironment(owner, project.project_id, {
        name: "Development",
        slug: "development",
        kind: "development",
        region: "us-east-1",
        program_id: "brand-a-rewards"
      });
      const original = repository.membership.bind(repository);
      const membership = vi.spyOn(repository, "membership");
      if (kind === "inactive-member") {
        membership.mockImplementation(async (organizationId, issuer, subject) => {
          if (organizationId === org && subject === foreign.subject) {
            return {
              organization_id: org,
              issuer,
              subject,
              role: "admin",
              active: false,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            };
          }
          return original(organizationId, issuer, subject);
        });
      }
      const actor =
        kind === "scoped-operator"
          ? {
              ...foreign,
              operator: {
                operator_id: "operator-brand-b",
                role: "org-scoped" as const,
                organization_ids: [brandB.organization.organization_id]
              }
            }
          : foreign;
      const rotate = vi.fn();
      const operate = vi.fn();
      const beforeAudit = await repository.auditForOrganization(org);
      // Authentication is a test boundary; route, service, membership and
      // repository behavior remain real. OIDC/key verification has its own tests.
      const running = await startCloudServer(cloud, {
        port: 0,
        authenticator: { authenticate: async () => actor },
        rotateEnvironmentCredentials: rotate,
        operateLocalEnvironment: operate
      });
      try {
        for (const route of routes(org, project.project_id, environment.environment_id)) {
          membership.mockClear();
          const response = await fetch(`${running.url}${route.path}`, {
            method: route.method,
            headers: {
              authorization: "Bearer test-identity",
              "content-type": "application/json",
              "idempotency-key": "credential-isolation-test"
            },
            ...(route.method === "GET" ? {} : { body: JSON.stringify(route.body ?? {}) })
          });
          expect(response.status, `${kind}: ${route.method} ${route.path}`).toBe(404);
          expect(await response.json()).toMatchObject({
            type: "https://loyalty-interchange.org/problems/not_found",
            code: "not_found",
            detail: "Organization was not found"
          });
          expect(membership).toHaveBeenCalledWith(org, owner.issuer, foreign.subject);
        }
        expect(rotate).not.toHaveBeenCalled();
        expect(operate).not.toHaveBeenCalled();
        expect(await repository.auditForOrganization(org)).toEqual(beforeAudit);
        expect(await repository.projectsForOrganization(org)).toHaveLength(1);
        expect(await repository.environmentsForProject(project.project_id)).toHaveLength(1);
      } finally {
        await running.close();
        await cloud.close();
      }
    }
  );
});
