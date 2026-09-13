# Contributing to LIP

Loyalty Interchange Protocol is developed in the open. Changes to normative
behavior start as an issue or proposal and must include conformance fixtures.

## Local development

Use Node.js 22.13+ (or 24+) for the supported ESLint toolchain. `npm run lint`
checks maintained JavaScript/TypeScript for correctness; `npm run verify` runs it
in CI as well. Generated SDK output and build/dependency directories are excluded;
schema-generation checks, types and tests remain separate required gates.

```sh
npm install
npm run audit:check
npm run verify
```

The audit includes development dependencies and fails on moderate-or-higher
advisories. It runs in CI after the locked install and needs npm registry access;
network failure is not a clean audit. Keep the full deterministic verify gate too.

Configuration is read from the process environment. Nothing in this repo reads a
`.env` file implicitly, so export the values yourself. Every value in
`.env.example` is a documented local-development default:

```sh
cp .env.example .env
set -a; . ./.env; set +a
npm run dev
```

`.env` is gitignored. The PostgreSQL storage suite and the cloud control plane
need a database; `docker compose up -d postgres` provides one.

## Compatibility policy

- Patch releases clarify documentation and fix implementation defects.
- Minor releases may add optional fields, operations, event types, or profiles.
- Major releases may change required fields or existing semantics.
- Implementations must ignore unknown optional object properties unless a schema
  explicitly prohibits them.
- A normative change is incomplete until the JSON Schema, OpenAPI document,
  examples, and conformance tests agree.

## Design principles

1. Model the transaction lifecycle, not a vendor's product surface.
2. Keep financial values exact and make funding ownership explicit.
3. Make retries safe through idempotency.
4. Separate the cross-vertical core from profile-specific semantics.
5. Prefer existing Internet standards over custom transport conventions.
