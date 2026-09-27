# Contributing

This repository implements the Hostsphere product and engineering specification
(v1.1). Every change should be traceable to a requirement identifier such as
`CAL 03` or `EXPORT 02`, and every claim of completion needs evidence.

## Before you start

- Use Node.js 22.14–24.x and the pnpm version pinned in `package.json`
  (`corepack enable` selects it automatically).
- Install with `pnpm install --frozen-lockfile`. Do not edit the lockfile by
  hand; add or upgrade dependencies with `pnpm add`.
- Copy `.env.example` to `.env` for local work. Never commit `.env`, real feed
  URLs, export tokens, guest data, or production database dumps.

## Local checks (the same gates CI runs)

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test                # unit, domain, fixture and property-based tests
pnpm test:integration    # needs TEST_DATABASE_URL (a disposable PostgreSQL)
pnpm build
pnpm audit:deps
```

`pnpm test:integration` rebuilds the schema of the database in
`TEST_DATABASE_URL`, so point it only at a disposable database. It connects the
application through a `NOSUPERUSER NOBYPASSRLS` role so row-level security is
exercised exactly as in production. Without `TEST_DATABASE_URL` the suite skips
and says so; CI sets `REQUIRE_INTEGRATION_TESTS=1`, which turns a skip into a
failure.

## Calendar code rules

The calendar core in `src/domain/calendar/` is a pure functional core (ARCH 01):

- Stage functions take validated observations, policy, and a supplied clock and
  return decisions. They do not read the database, call the network, or read
  `Date.now()`/`Math.random()`.
- Adapters in `src/server/calendar/` perform I/O and persist exactly what the
  core decided, inside fenced transactions.
- A change that can open dates, disclose access, duplicate an external effect,
  or lock a host out needs a failing test first, then the fix.
- Availability is never released by reconciliation. Only a host decision
  releases protected dates in the beta (LIFE 01).

## Migrations

Follow MIG 01: expand, backfill, validate, switch, contract. The pre-launch
rebuild exception applies only while no real host data exists and the product
owner has confirmed that in writing (see `docs/RELEASE_GATES.md`). Custom SQL
protections (RLS, composite keys, checks, triggers) live in migrations; never use
`prisma db push`.

## Pull requests

- Name the requirement identifiers the change satisfies and attach evidence
  (test names, command output, screenshots) in the pull request template.
- Keep secrets and personal data out of code, tests, fixtures, logs and
  screenshots. Calendar fixtures must be synthetic or anonymized with
  `pnpm fixtures:anonymize`.
- CI must be green on the head commit. `main` is protected; see
  `docs/RELEASE_GATES.md` for the required checks.
