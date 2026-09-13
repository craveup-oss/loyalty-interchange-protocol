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

- [ ] First prove `npm run lint` is absent, then add an executable regression
      test that valid TypeScript passes and a real correctness defect fails.
- [ ] Add the pinned lint dependencies, configuration and `verify` integration.
- [ ] Fix only confirmed findings, run full verification including disposable
      PostgreSQL, review and normal merge to `dev`.

No deployment, tenant data, scheduling or credential changes. This closes only
the lint subtask: distributed ownership and multi-instance proof remain open.
