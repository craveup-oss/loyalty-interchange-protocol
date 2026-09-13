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
- [x] Refresh only affected dependencies within existing ranges; raise the
      directly declared Vitest/coverage minimum together. No force upgrades,
      broad overrides, dependency removals or advisory suppressions.
- [x] Add `audit:check` to the existing CI verification job.
- [ ] Require zero reported vulnerabilities at this checkpoint, full verification
      with disposable PostgreSQL, generated artifact parity and package/release
      checks. Review the exact lockfile and normal merge after CI.

The audit command requires registry access and fails visibly when unavailable;
it does not replace deterministic local tests. Production rollout and distributed
loyalty coordination remain separate gates.

## Local result

The updated graph reports **zero vulnerabilities**. Vitest/coverage move together
to 4.1.11; fast-uri to 3.1.7, Hono to 4.13.7, qs to 6.16.0, browserslist to 4.28.9
and baseline-browser-mapping to 2.11.23. Their compatible support dependencies are
retained in the lockfile; unrelated cross-platform optional entries are preserved.
No force upgrade, package override or advisory suppression was used.

Full local `npm run verify` passed with disposable PostgreSQL: 66 suites / 505
tests, 86.99% statements, 77.70% branches, 93.57% functions and 88.38% lines.
Lint, generation, types, examples, builds, package checks, docs mirrors and launch
checks passed, followed by `spec:check` and `release:manifest:check`. Hosted CI and
exact-head review remain required before normal merge.
