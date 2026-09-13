# Loyalty dependency audit — PLA-988

Parent: PLA-919. Follow the lint increment; no runtime redesign or deployment.

## Confirmed baseline

The installed and locked graph reports eight advisories (two high, six moderate):
fast-uri, browserslist, baseline-browser-mapping, Hono, qs, Vitest, its mocker and
coverage package. All have fixes within existing dependency ranges. The unchanged
pre-lint base also had a js-yaml advisory, already removed by its compatible patch.

For example, the maintainer advisories identify patched
[fast-uri 3.1.6](https://github.com/fastify/fast-uri/security/advisories/GHSA-5jgf-p345-68v8),
[Vitest 4.1.11](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9),
and [Hono 4.13.5](https://github.com/honojs/hono/security/advisories/GHSA-g6gw-c38x-mqfc).
An advisory does not by itself prove this deployment is exploitable, but keeping
compatible fixes out of an unreleased platform is unnecessary risk.

## Execution and acceptance

- [x] Reproduce the audit failure and trace actual dependency owners.
- [ ] Refresh only affected dependencies within existing ranges; raise the
      directly declared Vitest/coverage minimum together. No force upgrades,
      broad overrides, dependency removals or advisory suppressions.
- [ ] Add `audit:check` and run it in the existing CI verification job.
- [ ] Require zero reported vulnerabilities at this checkpoint, full verification
      with disposable PostgreSQL, generated artifact parity and package/release
      checks. Review the exact lockfile and normal merge after CI.

The audit command requires registry access and fails visibly when unavailable;
it does not replace deterministic local tests. Production rollout and distributed
loyalty coordination remain separate gates.
