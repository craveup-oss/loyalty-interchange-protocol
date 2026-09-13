# Loyalty correctness lint gate — PLA-919

## Scope

Add the missing local and CI lint gate from PLA-919. Use ESLint flat configuration
with the TypeScript parser, covering maintained applications, packages, scripts,
tests, examples and root configuration. Exclude generated artifacts and dependency
trees, not handwritten runtime code. Keep type checking and all existing tests.

Use correctness rules rather than a formatting or broad style rewrite. TypeScript
owns undefined-name and type syntax checks; JavaScript keeps its own undefined-name
check. Do not hide findings with a baseline or blanket source-directory exclusions.

## Verification

- [x] First prove `npm run lint` is absent, then add an executable regression
      test that valid TypeScript passes and a real correctness defect fails.
- [x] Add the pinned lint dependencies, configuration and `verify` integration.
- [ ] Fix only confirmed findings, run full verification including disposable
      PostgreSQL, review and normal merge to `dev`.

No deployment, tenant data, scheduling or credential changes. This closes only
the lint subtask: distributed ownership and multi-instance proof remain open.

## Verification and review notes

The CLI regression first failed because the lint script was missing. With the
configuration it accepts valid TypeScript and rejects a duplicate switch case.
Full verification passes with disposable local PostgreSQL: 66 suites / 505 tests,
86.97% statement coverage. Types, generation, examples, builds, package checks,
documentation mirrors and launch checks remain green.

ESLint 10 is supported and pinned; source development now requires Node 22.13+
or 24+, matching its engine requirement. The first lint pass found redundant CSV
fixture escaping and an overwritten initializer; both were corrected without
changing behavior. The new `preserve-caught-error` rule is deliberately not adopted:
attaching raw provider/credential errors changes diagnostic exposure and needs a
separate privacy review, not an automatic tooling fix.

The lockfile refresh also takes the compatible js-yaml security patch. An audit
of the unchanged base reported nine advisories (three high); the resulting graph
has eight (two high), none introduced by lint dependencies. Those pre-existing
advisories are not declared resolved by this lint-only change.
