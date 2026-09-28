# Release gates: Phase 0 and Phase 1

This is the evidence record for Appendix B of the Hostsphere Product and
Engineering Specification v1.1. Appendix B says an item is done when its
acceptance evidence is attached. Each row below names the requirements it
satisfies, what this repository contains, the evidence, and what remains.

Status words:

- **Built**: implemented here, with automated evidence named in the row.
- **Operator**: needs an action outside the repository (settings, accounts,
  deployments). The steps are below; fill in the record when it is done.
- **Decision**: waits on an owner decision in the decision register (§28).
- **Exception**: a recorded gap, its reason, and what closes it (QA 03).

Nothing in this file marks an operator step or a decision as complete. A
workflow file is not evidence that a check passed; a run is (QA 03).

## Phase 0 Foundation

| Item                                                                                      | Requirements    | Status                                    | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Remaining                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------- | --------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Confirm in writing that no real host data exists; take and verify a backup                | MIG 01          | Operator                                  | `pnpm db:prelaunch-check` prints row counts per workspace, never content. The calendar rebuild migration refuses to run over legacy calendar rows and keeps existing export links and tasks (`tests/database.test.ts`: "MIG 01: the calendar rebuild refuses to run over legacy calendar rows", "MIG 01: existing export links and tasks survive the pre-launch rebuild").                                                                                                                                                                                                                                                                                          | The product owner's written confirmation and a verified backup, recorded [below](#mig-01-written-confirmation), before `202609270002_calendar_correctness` runs on any existing database |
| Decide repository visibility and license; remove demo artifacts after checking references | REL 03          | Decision (D11); artifacts Built           | Checked on 2026-09-28: the repository is public with no license file, so default copyright applies. No change was imposed. `git ls-files` holds no demo artifacts; `public/` contains only the favicon and service worker the app serves. Contributor guidance (`CONTRIBUTING.md`), release notes (`CHANGELOG.md`), vulnerability reporting (`SECURITY.md`) and a pull request template exist.                                                                                                                                                                                                                                                                      | The owner decides visibility and license (D11) and enables private vulnerability reporting                                                                                               |
| CI on every pull request: frozen install, type check, lint, tests, build; protect main    | QA 03           | Built; branch protection Operator         | `.github/workflows/ci.yml` runs on every pull request and push to `main`: frozen install, typecheck, lint, format check, unit/domain/fixture/property tests, integration tests on PostgreSQL 16 with RLS enforced (a skip fails the job), production build, targeted Chromium checks against the build, and a dependency audit. `.github/workflows/codeql.yml` runs CodeQL security-extended queries.                                                                                                                                                                                                                                                               | Protect `main` with the three required checks [below](#branch-protection-for-main)                                                                                                       |
| Create an isolated staging project; previews never use production data                    | SEC 04          | Interlock Built; staging project Operator | Each database carries an environment marker written only by the schema owner (`pnpm db:mark-environment`). The app refuses tenant data when `APP_ENVIRONMENT` does not match it; a Vercel preview can never run as production; a staging database serves staging and previews only (`src/server/db.ts`; `tests/operations.test.ts`: "SEC 04: each deployment serves only a database of its own environment"). `GET /api/health/operations?check=environment` reports a mismatch.                                                                                                                                                                                    | Create the staging project and complete the [staging checklist](#staging-isolation)                                                                                                      |
| External scheduler with heartbeat and a separate work-progress signal                     | ARCH 03, OPS 01 | Built; clock and monitors Operator        | `POST /api/cron` runs one tick under a database lease and records start, completion, claimed, completed, failed, retries, oldest due item and remaining backlog in `SchedulerTick`; overlapping ticks are recorded as skipped. `ops/clock` is the one-minute external clock; `pnpm worker` runs the same tick. Heartbeat, progress, backups and environment are separate checks (`tests/integration/operations.test.ts`: "a tick claims due work and records durable progress", "an overlapping tick is recorded as skipped and does no work", "heartbeat, progress, backups and environment are separate checks").                                                 | Deploy one clock per environment and configure the [monitors](#monitors)                                                                                                                 |
| Nightly backups of Postgres, storage objects and encryption keys through separate paths   | REC 01          | Built; enablement and drill Operator      | `.github/workflows/backup.yml` runs three jobs with separate credentials: `pg_dump` as a backup role that can write nothing but its own evidence rows, proven by a full restore into a scratch database; every stored photo checked against its recorded SHA-256; the key escrow proven to decrypt a real ciphertext of every key version in use. Artifacts are sealed to an offline RSA key before they are written. Each outcome is recorded in `BackupRun`; `check=backups` alerts after 26 hours (`tests/operations.test.ts`: "REC 01: backup artifacts are sealed to the offline key and reject tampering", "REC 01: archive coverage and key escrow checks"). | Enable backups and run the [restore drill](#backups-and-restore-drill); D09 acceptance                                                                                                   |
| Set the database pool size explicitly per process                                         | Section 2       | Built                                     | `DATABASE_POOL_SIZE` (web) and `WORKER_DATABASE_POOL_SIZE` (worker) set the application's connection pool, with explicit defaults of 1 per serverless function, 3 for a local web server and 4 for the worker. `pnpm check:env` validates them (`tests/operations.test.ts`: "Section 2: the pool size is explicit per process type and validated").                                                                                                                                                                                                                                                                                                                 | Set values per environment so that function concurrency × pool size stays within the database plan                                                                                       |

**Phase 0 gate: CI required on main; staging isolated from production;
heartbeat and backup freshness alerts live.** Open. The code for every item is
in place; the gate closes when branch protection, the staging project, the
clocks, the four monitors and the first verified backups are recorded below.

## Phase 1 Calendar correctness

| Item                                                                                                  | Requirements            | Status                              | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------- | ----------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anonymized fixtures from Airbnb, Vrbo, Booking.com and Google, plus synthetic edge cases              | QA 01, CLASS 01         | Synthetic Built; real **Exception** | `tests/fixtures/`: synthetic DST, leap day, duplicate UID, recurrence, malformed, truncated, horizon pair, cancellation ordering, output loop, empty and non-calendar cases, and platform-shaped files; `pnpm fixtures:anonymize` removes everything outside an allowlist (`tests/anonymizer.test.ts`). No real platform export is committed yet (see [exceptions](#recorded-exceptions)).                                                                                                                                                                                    |
| Data model with forced RLS and composite keys                                                         | DATA 01–03, SEC 01      | Built                               | Migration `202609270002_calendar_correctness`: `ChannelConnection` with classification policy, `FeedObservation`, `AvailabilityBlock`, `Reservation`, `ConflictCase`, `ExportVersion`, `ExportRetrieval`, all under forced RLS with workspace/property composite keys; no overlap exclusion constraint; bounded snapshots, no raw bodies (`tests/database.test.ts`, `tests/integration/calendar.test.ts`: "tenant boundaries hold for the application role across randomized writes").                                                                                        |
| The ten stages as pure functions with a supplied clock                                                | ARCH 01, CAL 01, CAL 02 | Built                               | `src/domain/calendar/` (schedule, parse, normalize, health, classify, compare, lifecycle, conflicts, export, pipeline) performs no I/O and never reads the clock; `src/server/calendar/` persists exactly what it decides (`tests/calendar-core.test.ts`).                                                                                                                                                                                                                                                                                                                    |
| Harden fetching                                                                                       | FETCH 01–03             | Built                               | HTTPS on 443 only (a plaintext link is offered its HTTPS form, never fetched), per-platform registrable-domain rules, private/reserved address blocking with a pinned resolved address, redirects validated hop by hop (max 3), one deadline across DNS/redirects/body, size bound after decompression, conditional requests, `Retry-After` never truncated, 15-minute interval (5 near a stay) with jitter, failure backoff and per-platform budgets (`tests/calendar-fetch.test.ts`; "FETCH 02/03: intervals, jitter bounds and Retry-After are honored, never truncated"). |
| Connection-scoped UIDs and recurrence identity; no date-based surrogate identities                    | ID 01, ID 02, DATA 02   | Built                               | Identity is the connection plus UID plus recurrence reference; a moved override keeps one identity; disagreeing duplicates go to review. An event without a UID gets a local surrogate that only protects its dates: it is always Unknown, flagged "identity uncertain", never treated as a durable reservation identity, and cannot authorize removing another block ("ID 01: …", "ID 02: events without identity stay unknown and cannot authorize removals").                                                                                                              |
| Date rules                                                                                            | DATE 01, DATE 02        | Built                               | Exclusive end dates, the one-day default, property-zone adapter rules with ambiguous and skipped wall times sent to review, recurrence bounded by window and 3,000 occurrences (reaching a bound makes the observation incomplete), a shorter horizon never read as cancellation ("DATE 01: …", "DATE 02: …", fixtures "DST", "leap day", "horizon").                                                                                                                                                                                                                         |
| Health gate                                                                                           | CAL 02, section 10      | Built                               | Failed, partial, empty and mass-disappearance observations can add protection but never remove it; an anomalous verdict sticks to identical content ("Health gate: …", "CAL 04: anomalous content stays anomalous when it is simply seen again"; integration: "failed, empty and repeated anomalous checks never remove protection").                                                                                                                                                                                                                                         |
| Classification with recorded evidence and the per-connection policy question                          | CLASS 01, CLASS 02      | Built                               | Every block stores its classification evidence and rules version. Unverified label rules only pre-select an answer by label; until the host answers, blocks stay Unknown, protected, with no turnover work. The answer is stored with actor, time and the evidence shown, applies to later events, and can be changed ("CLASS 02: …"; integration: "a check applies, the host answers the policy question…", "classifying each block yourself answers the policy question"; browser: "the policy question pre-selects by label, saves, and reopens with the stored answer").  |
| Missing and cancellation lifecycle with ask-before-reopening; no hard deletes; past stays not watched | LIFE 01–04              | Built                               | Missing from one complete healthy check marks a block missing; a second such check at least 15 minutes later asks the host; only a host releases, after confirming the platform; restore compensates for 24 hours; cancellations respect source ordering; ended stays are not watched; routine work cannot delete history ("Worked example (section 15): …", "LIFE 01: …", "LIFE 02: …"; database: "routine operations never hard-delete calendar or cleaning history"; integration: "a vanished stay stays protected until the host reopens it; restore compensates").       |
| Fenced apply with expected revision; repeated observations change nothing                             | CAL 03, CAL 04, AUTO 03 | Built                               | Each run holds a lease fence and commits against the listing's expected revision; host actions carry expected revisions and return 409 with the current state ("CAL 04: repeating the same observation produces no further changes"; integration: "a superseded worker cannot commit", "repeating the same check changes nothing").                                                                                                                                                                                                                                           |
| Versioned exports with stable UIDs, ETag and 304, retrieval classes and hashed tokens                 | EXPORT 01–03            | Built                               | Each export link is scoped to one destination (its own stays excluded, buffers kept), versioned by content digest, served with a strong ETag, 304 and HEAD; retrievals are classified and bounded; only token hashes are stored; rotation revokes a generation and counts stale-link hits; refreshed daily as history ages out ("EXPORT 01: …"; property test "EXPORT 01: exports hold protection…"; integration: "exports: own stays excluded, buffers kept, ETag/304/HEAD, rotation").                                                                                      |
| Turnover tasks only from reservations; cancelled and superseded cleaning states                       | CLEAN 01, CLEAN 03      | Built                               | Turnover work exists only for reservations and closes with a reason; changed dates supersede unstarted work and notify an assigned cleaner; work under way is flagged for the host, never silently cancelled (database: "turnover work exists only for reservations and closes with a reason"; integration: "shadow mode serves no calendar; going live creates the withheld turnovers").                                                                                                                                                                                     |
| Conflict detection with canonically ordered pairs                                                     | CONFLICT 01             | Built                               | Byte-ordered pairs, one open case per pair and reason, four kinds, updates without re-alerting, never reopening dates ("CONFLICT 01: …"; database: "conflict cases use byte-ordered canonical pairs with one open case each"; integration: "overlaps across calendars open one canonical case each"; browser: "an overlapping hold needs acknowledgement and opens an overlap case").                                                                                                                                                                                         |
| Manual holds and host overrides kept distinct from imported facts                                     | MANUAL 01, MANUAL 02    | Built                               | Holds, direct reservations, classification and buffer overrides are stored beside the imported facts; a source change under an override keeps protection, opens review and shows both values ("MANUAL 02: a source change under a host override keeps protection and opens review").                                                                                                                                                                                                                                                                                          |
| Redact feed URLs and tokens from logs and errors                                                      | SEC 03                  | Built                               | Feed URLs are encrypted at rest and reduced to their origin in logs; telemetry events are scrubbed before sending (`tests/redaction.test.ts`); the shadow report prints no secrets (integration: "the shadow report prints evidence without secrets or guest details").                                                                                                                                                                                                                                                                                                       |
| Property-based tests for protection, identity, revision monotonicity and tenancy                      | QA 01                   | Built                               | `tests/calendar-properties.test.ts` (randomized histories; `PROPERTY_RUNS` raises the count) and the randomized tenancy test in `tests/integration/calendar.test.ts`.                                                                                                                                                                                                                                                                                                                                                                                                         |
| Shadow mode for seven representative days; adjudicate every disagreement                              | REL 01                  | Built; the review Operator          | New workspaces start in `SHADOW`: decisions are recorded, exports answer "not active yet", no alerts or turnover changes. `pnpm calendar:shadow-report` lists every item to adjudicate; `pnpm calendar:mode <workspace> LIVE --reviewed <evidence>` goes live and creates the withheld work idempotently.                                                                                                                                                                                                                                                                     |
| Honest run results shown to the host                                                                  | CAL 05                  | Built                               | Each connection shows what the last check observed, when it last succeeded and when the next check is due or overdue; nothing claims a calendar is "synced" or that a platform imported a link (`tests/calendar-copy.test.ts`; browser: "a host signs in and sees the pending policy question and honest check result").                                                                                                                                                                                                                                                      |

**Phase 1 gate: critical invariants and real supported feed fixtures pass.**
Open. The invariants pass (see [RELEASE_CHECKS.md](RELEASE_CHECKS.md) for the
run). Real fixtures do not exist yet, so no platform label rule is verified and
no channel is advertised as verified (D03). The gate closes when an anonymized
real export for each advertised platform passes `tests/fixtures.test.ts` and
the shadow review below is adjudicated.

## Records

Fill these in as the work happens and link the evidence (an issue, a run URL,
a screenshot). Leave a record blank rather than writing what was intended.

### MIG 01 written confirmation

The pre-launch exception allows one reviewed rebuild instead of expand and
backfill only while no real host data exists, confirmed in writing by the
product owner after a verified backup.

1. Run `pnpm db:prelaunch-check` with the schema owner as `DIRECT_URL` and
   attach the output (counts only).
2. Take a backup (`pnpm backup postgres`) and verify it by restoring into a
   scratch database (`BACKUP_VERIFY_DATABASE_URL`).
3. The product owner confirms in writing.

| Field                                        | Value |
| -------------------------------------------- | ----- |
| Database (environment marker)                |       |
| `db:prelaunch-check` output attached         |       |
| Backup artifact SHA-256 and restore evidence |       |
| Product owner confirmation (name, date)      |       |
| Migrations applied afterwards                |       |

From the first real host onward, expand, backfill, validate, switch and
contract is mandatory, and the export UID format is frozen (D15).

### Branch protection for main

Settings → Branches → add a rule (or ruleset) for `main`:

- Require a pull request before merging.
- Require status checks to pass, with these checks (names as CI reports them):
  - `Typecheck, lint, tests, build`
  - `Dependency audit (high and critical)`
  - `Analyze (javascript-typescript)`
- Require branches to be up to date before merging.
- Block force pushes and deletion.

| Field                              | Value |
| ---------------------------------- | ----- |
| Enabled by, date                   |       |
| First pull request with all checks |       |

### Staging isolation

- [ ] A separate hosting project, database, private storage bucket and
      secrets (`AUTH_SECRET`, `CRON_SECRET`, `MONITOR_SECRET`, encryption
      keys) for staging; nothing shared with production.
- [ ] The staging database marked `staging` and production marked
      `production` with `pnpm db:mark-environment` (schema owner).
- [ ] `APP_ENVIRONMENT=production` only in the production environment;
      `staging` for staging; `preview` for preview deployments, whose
      `DATABASE_URL` points at the staging database.
- [ ] `GET /api/health/operations?check=environment` returns 200 in each.
- [ ] A preview deployment pointed at the production database refuses to serve
      data (try once, then remove the setting).

### Monitors

Configure four HTTP monitors per environment, each sending
`Authorization: Bearer $MONITOR_SECRET` and alerting on any non-200 status
(`ops/clock/README.md` has the thresholds).

| Monitor          | URL                                        | Configured (service, date) | Test alert received |
| ---------------- | ------------------------------------------ | -------------------------- | ------------------- |
| Heartbeat        | `/api/health/operations?check=heartbeat`   |                            |                     |
| Work progress    | `/api/health/operations?check=progress`    |                            |                     |
| Backup freshness | `/api/health/operations?check=backups`     |                            |                     |
| Environment      | `/api/health/operations?check=environment` |                            |                     |

### Backups and restore drill

Setup is in [OPERATIONS.md](OPERATIONS.md#backups-and-restore). A job that
exits successfully is not enough evidence; a restore is (REC 01).

| Field                                                          | Value |
| -------------------------------------------------------------- | ----- |
| Backup key pair generated; private key stored offline (where)  |       |
| `backups` environment, secrets and `BACKUPS_ENABLED` set       |       |
| First run of all three jobs (run URL)                          |       |
| Restore drill: artifact, isolated target, duration, row counts |       |
| Photos and keys restored and a record decrypted                |       |
| Recovery objective accepted (D09: proposed 24 h RPO, 4 h RTO)  |       |

### Shadow review

REL 01: review disagreements against source evidence and the agreed fixtures,
over seven representative days plus the edge-case replay in `pnpm test`.

1. `pnpm calendar:shadow-report <workspace> --days 7 --markdown` and attach it.
2. Adjudicate every listed item against the platform's own calendar: record
   whether the engine's decision was right, and for each wrong one the fix and
   its regression test.
3. Go live with a reference to this record:
   `pnpm calendar:mode <workspace> LIVE --reviewed <link>`.

| Field                                            | Value |
| ------------------------------------------------ | ----- |
| Workspace and window                             |       |
| Report attached                                  |       |
| Items adjudicated / engine decisions found wrong |       |
| Fixes and regression tests                       |       |
| Reviewed by, date; went live (commit)            |       |

## Recorded exceptions

QA 03 asks for tool availability and exceptions to be recorded.

- **Real platform fixtures.** None are committed; the platform files are
  synthetic. Consequently every label rule has an empty `verifiedBy` list and
  only pre-selects an answer by label; every connection goes through the
  host's policy question. Closes when anonymized real exports are committed
  (see `tests/fixtures/README.md`).
- **Browser coverage.** CI runs targeted Chromium checks against the production
  build at desktop and phone widths. There is no cross-browser run, screen
  reader or manual keyboard audit yet; those are QA 02 (Phase 4).
- **Capacity.** A tick is bounded (48-second budget under a 58-second lease,
  per-platform budgets), but no load test has been run; the cadence is not
  capacity-certified.
- **Dependency audit.** One recorded exception, GHSA-ggr8-5vv4-36mx, with its
  reason and revisit trigger in `pnpm-workspace.yaml`.
- **Code scanning.** CodeQL runs at no cost because the repository is public.
  If visibility changes (D11), confirm the plan still includes code scanning.
- **Branding.** Visible branding stays "Airbnb Automation" until the trademark
  and domain search (D11); compatibility identifiers are unchanged.

## Decisions this work depends on

| ID  | Decision                           | State in this repository                                                                                                                                                                                        |
| --- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D02 | Cancellation release policy        | Implemented as recommended: ask before reopening (LIFE 01). LIFE 05 reminders are Phase 4.                                                                                                                      |
| D03 | Supported launch channels          | No channel is verified yet (no real fixtures); nothing is advertised as verified.                                                                                                                               |
| D06 | Hosting budget                     | Open. The external clock does not depend on the Vercel plan's cron cadence; commercial eligibility is still the owner's decision.                                                                               |
| D09 | Recovery objective                 | Open. Nightly backups support the proposed 24-hour RPO; the 4-hour RTO needs a timed restore drill and owner acceptance.                                                                                        |
| D11 | Brand and repository               | Open. No visibility, license or visible-branding change was made.                                                                                                                                               |
| D13 | Default for single-label platforms | Implemented as recommended: ask the host per connection; no silent default.                                                                                                                                     |
| D15 | Export UID format freeze           | Frozen in code: `<blockId>@airbnb-automation`, with `<blockId>-pre@airbnb-automation` and `<blockId>-post@airbnb-automation` for buffer days. It must not change once any platform has imported an export link. |
