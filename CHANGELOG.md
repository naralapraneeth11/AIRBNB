# Changelog

Notable changes, newest first. Requirement identifiers refer to the Hostsphere
Product and Engineering Specification v1.1. Gate evidence lives in
[docs/RELEASE_GATES.md](docs/RELEASE_GATES.md).

## Unreleased: removing a property, and security updates

### Before you upgrade

- **Migration.** Apply `202610070001_property_removal` (`pnpm db:migrate`)
  and re-run `prisma/grants/runtime-role.sql` as after every migration. It
  only widens one check constraint, so it is safe before or after deploying
  the code; until it runs, removing a property fails and changes nothing.

### Added

- **Remove a property from the app** (owner only, in the property's
  Overview). The dialog lists what will stop, and the button stays disabled
  until the property's name is typed. Nothing is changed or deleted on
  Airbnb, Vrbo or any other platform:
  - its calendars are no longer fetched, and a check already downloading
    cannot apply what it fetched;
  - its export links answer "not found", never an empty calendar, so no
    dates open up anywhere; the dialog names links a platform read recently
    so they can be removed there;
  - cleaning work that has not begun is cancelled as for a cancelled stay,
    and the cleaner who held a job is told (when cleaning automation is
    on); removal waits while a cleaning started in the last 12 hours is
    under way;
  - unsent replies are held as drafts, and new guest messages get no
    prepared reply or alert;
  - it leaves the calendar, Inbox, cleaning, reports, alerts and setup, and
    every action on it is refused with a clear message.
- **Restore** from Properties → Removed properties. History is never
  deleted (as everywhere in this app), so restoring brings the property
  back with its calendar links (only those the removal paused), checks
  them straight away, and recreates cleaning work for upcoming stays. The
  removed list shows a platform still requesting a paused link.

### Security

- Next.js 16.3.6, fixing a critical advisory published after the last
  release (GHSA-vcvr-r3jv-pc5j, remote code execution through `next/og`
  `ImageResponse`, which this app does not use).
- Patched sharp (0.35.5) and source-map-js (1.2.2) everywhere, through
  overrides where Next.js and build tools still allowed older releases.
- The braces advisory (GHSA-vfj7-8cjw-p6xm) has no fixed release yet. It
  reaches only the linter, on this repository's own files, so it is
  recorded as an audit exception pending the owner's confirmation.

## Inbox reliability, calendar dates and phone navigation ([#3](https://github.com/naralapraneeth11/AIRBNB/pull/3))

### Before you upgrade

- **Nothing to run.** No migration and no new settings.
- **Inbox addresses changed.** The open conversation and the filters are
  now part of the address (`/inbox?thread=…&platform=…`), so a reload, a
  shared link and Back show the same thing. Older `/inbox?thread=…` and
  `/inbox?reservation=…` links still work.

### Fixed

- **A reply could go to a different guest than the one on screen.** A
  late answer for the previously open conversation could replace the one
  just chosen while Send still posted to the chosen one. Only the latest
  request can now update the screen, and Send always goes to the
  conversation shown.
- **Calendar:** in a week (or some month views) ending on the day clocks go
  back, the last day's stays were not loaded, such as a check-in on Sunday
  1 November 2026 in New York or 25 October 2026 in London.
- **Long conversations hid their newest messages:** only the oldest 500
  were loaded. Conversations now open on their newest messages, and
  "Show earlier messages" loads older ones without moving the reader.
- **Drafts were lost** when switching conversations, when a stay's
  conversation opened from the calendar re-selected itself every few
  seconds, or when words were typed while a reply was being sent. Each
  conversation keeps its own draft, and sending clears only the words
  that were sent. Drafts are not saved in the browser, since replies can
  contain guest details on shared devices.
- **Retries:** a reply retried after a lost answer is never sent twice,
  and the message says retrying is safe. A retry with different words is
  refused instead of silently dropped, and a retried suggestion approval
  that had already gone through no longer reports a failure.
- **Refresh failures** in the Inbox no longer show a permanent error; the
  conversation stays on screen with a "may be out of date" notice. Empty
  states appear only after a successful empty answer, with loading
  placeholders before that.
- **Filters:** while new results load, the old list is marked as updating
  and cannot be used, and a conversation outside the new results is not
  kept open.
- **Inbox actions** (manual takeover, resolve, dismiss, approve) can no
  longer be triggered twice while one is in progress, and show success only
  once the server confirms it. Queued replies are drawn differently from
  sent ones and read "Queued, not sent yet".
- **Phones:** the Inbox shows the list or one conversation, with "All
  conversations" and the browser's Back returning to the list where it
  was, including after opening a conversation straight from a link.
- **Phone navigation drawer:** when closed it was still reachable with Tab
  and by screen readers; when open, focus could leave it. Closed, it is
  now hidden; open, the page behind it is inert, focus stays inside,
  Escape closes it, and focus returns to the menu button.

### Changed

- The Inbox list ran two database queries per conversation on every
  refresh (up to 400); it now runs three for its data, however many
  conversations there are. An open conversation
  refreshes every 5 seconds and the list every 20 (previously both every
  2.5), refreshes pause while the tab is hidden, never overlap, and slow
  down after failures.
- Reading conversations is recorded in the audit log once per person and
  conversation every 10 minutes, instead of on every automatic refresh
  (about 2,900 entries an hour per open Inbox).

## Self-service accounts, guided setup and fixes ([#2](https://github.com/naralapraneeth11/AIRBNB/pull/2))

### Before you upgrade

- **Migration.** Apply `202609280001_accounts` (`pnpm db:migrate`) and
  re-run `prisma/grants/runtime-role.sql`. It only adds tables, so running
  it before or after deploying the code is safe: until it runs, sign-up,
  password reset and guided setup are unavailable and everything else keeps
  working.
- **Email (optional).** With `RESEND_API_KEY` and `EMAIL_FROM` (a verified
  domain), "Forgot your password?" works. Public sign-up also needs
  `SIGNUP_ENABLED=true`; leave it unset for a supervised demo.
- **Product name (optional).** `NEXT_PUBLIC_BRAND_NAME` sets the visible
  name; redeploy after changing it. The default is unchanged.

### Added

- Self-service sign-up with email verification: the account and its
  workspace are created only when the emailed link is used (AUTH 01).
- Password reset by email: single-use 30-minute links; a reset signs out
  every session (AUTH 03).
- A password policy of at least 14 characters with no composition rules,
  screened against known breaches through a privacy-preserving range
  query; it also applies to changing a password.
- Guided setup that saves progress after every step: property, calendar,
  export link, optional cleaner, and a rehearsal of the first actions
  (AUTH 04).
- The product name as one setting, including the calendar fetcher's user
  agent, pending decision D11.
- An Inbox note that platform messages need an approved messaging service.

### Fixed

- A save whose follow-up refresh failed was reported as failed, inviting a
  retry of something already saved; a failed background refresh replaced
  the workspace with an error screen. Both now show a "may be out of date"
  notice instead.
- A proxy timeout page surfaced as a JSON parse error; it is now explained,
  including that a save may have completed.

### Not yet

- Owner two-factor sign-in (AUTH 02) and emailed team invitations
  (AUTH 03) come next.

## Phase 0 Foundation and Phase 1 Calendar correctness ([#1](https://github.com/naralapraneeth11/AIRBNB/pull/1))

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
