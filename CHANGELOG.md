# Changelog

Notable changes, newest first. Requirement identifiers refer to the Hostsphere
Product and Engineering Specification v1.1. Gate evidence lives in
[docs/RELEASE_GATES.md](docs/RELEASE_GATES.md).

## Unreleased: Phase 0 Foundation and Phase 1 Calendar correctness

### Before you upgrade

- **Migrations.** Two new migrations: `202609270001_operations_foundation` and
  `202609270002_calendar_correctness`. The second rebuilds the calendar model
  under the MIG 01 pre-launch exception. On an existing database, run it only
  after the product owner confirms in writing that no real host data exists
  (`pnpm db:prelaunch-check`) and a backup has been verified. It refuses to run
  over legacy calendar rows and keeps existing export links and cleaning tasks.
- **Grants.** Runtime grants are now a shipped script. Re-run
  `prisma/grants/runtime-role.sql` as the schema owner after migrating; the old
  inline grant list in the deployment guide no longer matches the schema.
- **Environment marker.** Set `APP_ENVIRONMENT` in every deployment and mark
  each database with `pnpm db:mark-environment <name>`. The application refuses
  tenant data when they do not match (SEC 04).
- **Scheduler.** `vercel.json` declares no cron job (the previous deployment
  guide wrongly said it invoked `/api/cron`). Deploy the external one-minute
  clock in `ops/clock` (or run `pnpm worker`) and set `MONITOR_SECRET` for the
  new operations health endpoint (ARCH 03, OPS 01).
- **Calendar go-live.** Every workspace starts in calendar shadow mode. Export
  links answer "not active yet" until `pnpm calendar:mode <workspace> LIVE`
  after the shadow review (REL 01).
- `ICAL_ALLOWED_HOSTS` is now optional: platform links are checked against
  built-in domain rules, and the variable only restricts Google and other
  calendars.

### Phase 0 Foundation

- CI on every pull request: frozen install, typecheck, lint, format, unit,
  fixture and property tests, integration tests on real PostgreSQL with RLS
  enforced, production build, targeted Chromium checks against the build, and
  a dependency audit; CodeQL security scanning (QA 03).
- Scheduler ticks record start, completion, claimed, completed and failed
  work, retries, the oldest due item and the remaining backlog under a single
  database lease; overlapping ticks are recorded as skipped (ARCH 03, OPS 01).
- `GET /api/health/operations` reports scheduler heartbeat, work progress,
  backup freshness and environment as separate checks for external monitors.
- Environment interlock between deployments and databases, including previews
  (SEC 04).
- Nightly backups of Postgres, storage objects and encryption keys through
  three separate paths, each verified (full restore, SHA-256, key escrow) and
  sealed to an offline key; evidence recorded in `BackupRun` (REC 01).
- Explicit database pool size per process (section 2).
- `pnpm db:prelaunch-check` for the MIG 01 written confirmation.
- Contributor guidance, security policy, pull request template and this
  changelog (REL 03). Visibility, license and visible branding are unchanged
  pending decision D11.

### Phase 1 Calendar correctness

- A pure calendar core in `src/domain/calendar/`: ten stages with a supplied
  clock and no I/O, recorded rules and capability versions (ARCH 01, CAL 01).
- A new data model: connections with a classification policy, observations,
  availability blocks, reservations, conflict cases, export versions and
  retrievals, all under forced RLS with composite keys (DATA 01–03, SEC 01).
- Hardened fetching: HTTPS only, address pinning, validated redirects, one
  deadline, decompressed size bounds, conditional requests, `Retry-After`,
  jittered 15-minute checks (5 near a stay) and per-platform budgets
  (FETCH 01–03). Checks previously ran every 60–120 seconds.
- Connection-scoped identity that survives date changes; UID-less events only
  protect dates and never authorize removals (ID 01, ID 02, DATA 02).
- Exclusive end dates, property time zone rules and bounded recurrence; a
  shorter horizon is never read as cancellation (DATE 01, DATE 02).
- A health gate: failed, partial, empty and anomalous feeds can add protection
  but never remove it (CAL 02).
- Classification with recorded evidence and a per-connection policy question;
  unclear blocks stay Unknown, protected, with no turnover work (CLASS 01,
  CLASS 02, D13).
- Ask before reopening: a missing or cancelled stay waits for the host, who
  sees a release review; restore within 24 hours; no hard deletes; ended stays
  are not watched (LIFE 01–04).
- Fenced runs against an expected revision; repeating an observation changes
  nothing (CAL 03, CAL 04, AUTO 03).
- Destination-specific export links: versioned, strong ETag with 304 and
  HEAD, retrieval evidence, hashed tokens, rotation with stale-link counts, and
  a frozen UID format (EXPORT 01–03, D15).
- Turnover tasks only for reservations; cancelled and superseded cleaning
  states (CLEAN 01, CLEAN 03).
- Canonical overlap cases with severity and host resolution (CONFLICT 01).
- Holds, direct reservations, classification and buffer overrides kept
  distinct from imported facts; overlaps need acknowledgement (MANUAL 01,
  MANUAL 02).
- Feed URLs and tokens redacted from logs and telemetry (SEC 03).
- Shadow mode, `pnpm calendar:shadow-report` and `pnpm calendar:mode`
  (REL 01).
- Honest run results on every connection (CAL 05).
- Synthetic fixtures, `pnpm fixtures:anonymize` for real exports, randomized
  property tests, and integration tests on real PostgreSQL (QA 01).

### Fixed

- An anomalous feed seen again unchanged could be judged healthy and start
  absence review; the anomaly verdict now sticks to identical content (CAL 04).
- PostgreSQL `jsonb` reorders object keys, which made every check after a
  policy answer look like a change; evidence is now compared canonically
  (CAL 04).
- Reopening a by-label policy question showed "Guest reservation" for every
  label instead of the stored answer, so saving could turn owner closures into
  reservations with cleaning. The question now also pre-selects only "by
  label" from unverified suggestions, never "all guest reservations"
  (CLASS 02, CLEAN 01).

### Known limitations

- No real platform exports are committed as fixtures yet, so no label rule is
  verified and every connection asks its policy question.
- No load test, cross-browser run or screen-reader audit yet.
