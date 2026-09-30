# Delivery verification

A check counts as passed only when it ran (QA 03). This file records runs, not
intentions; gate status and remaining operator work are in
[RELEASE_GATES.md](RELEASE_GATES.md).

## Inbox reliability, calendar dates and phone navigation: September 30, 2026

Run locally against the working tree of the commit that adds this entry.
Same environment as below.

| Gate (CI order)                  | Result                                                                                                                                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | Passed                                                                                                                                                                                                                                |
| `pnpm typecheck`                 | Passed                                                                                                                                                                                                                                |
| `pnpm lint`                      | Passed: 0 errors, 16 warnings (19 before; the rewritten Inbox has 1 where it had 4)                                                                                                                                                   |
| `pnpm format:check`              | Passed                                                                                                                                                                                                                                |
| `pnpm test`                      | 100 passed, 0 failed, 0 skipped (adds calendar ranges across clock changes in five time zones)                                                                                                                                        |
| `pnpm test:integration`          | 29 passed, 0 failed, 0 skipped (adds the Inbox list, paging, read logging, reply retries and workspace isolation)                                                                                                                     |
| `pnpm build`                     | Passed                                                                                                                                                                                                                                |
| `pnpm test:browser`              | 26 passed, 0 failed, 0 skipped (adds the clock-change week, and 11 Inbox checks: late answers, drafts, a lost send answer, older messages, refresh failures, filters, queued replies, phone list and Back, and the navigation drawer) |
| `pnpm audit:deps`                | Passed: only the recorded exception GHSA-ggr8-5vv4-36mx                                                                                                                                                                               |

The calendar range test fails against the previous 24-hour arithmetic, and
the reply retry test against the previous reply handling. With the previous
Inbox and navigation code built and the new browser checks run against it,
9 of the 11 Inbox checks failed; the two that passed check that a retried
send reuses its key, which the old code also did, and that nothing else
failed. The new screens were reviewed by eye at desktop and phone widths,
which led to one fix (a "select a guest" message shown while the list was
still loading).

Not verified here: screen readers (the drawer and list behaviour were
checked through focus and the accessibility attributes, not with VoiceOver
or TalkBack), and the hosted deployment.

## Accounts, guided setup and fixes: September 28, 2026 (later)

Run locally against the working tree of the commit that adds this entry (code
as of `f152fa9`, plus documentation). Same environment as below.

| Gate (CI order)                  | Result                                                                                                                                       |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | Passed                                                                                                                                       |
| `pnpm typecheck`                 | Passed                                                                                                                                       |
| `pnpm lint`                      | Passed: 0 errors; the same 19 warnings as the original sources, none new                                                                     |
| `pnpm format:check`              | Passed                                                                                                                                       |
| `pnpm test`                      | 97 passed, 0 failed, 0 skipped (adds password policy, breach screen, email and brand tests)                                                  |
| `pnpm test:integration`          | 23 passed, 0 failed, 0 skipped (adds sign-up, reset and guided setup on PostgreSQL 16 through the runtime role)                              |
| `pnpm build`                     | Passed                                                                                                                                       |
| `pnpm test:browser`              | 14 passed, 0 failed, 0 skipped (adds sign-up, email link, setup, reset and sign-in; a failed refresh after a save; an unreadable error page) |
| `pnpm audit:deps`                | Passed: only the recorded exception GHSA-ggr8-5vv4-36mx                                                                                      |

The refresh check was confirmed to fail against the previous save handling
(no "Saved" confirmation appeared) and to pass with the fix. The new screens
were also reviewed by eye at desktop and phone widths, which led to two
styling fixes (a dimmed current step, and a phone layout that pushed the
form below the fold).

Not verified here: real email delivery through Resend, the breach screen
against the live Pwned Passwords service from this network (the checks run
with it unreachable, which exercises the fail-open path), and the hosted
deployment.

## Phase 0 and Phase 1: September 28, 2026

Run locally against the working tree of the commit that adds this record: code
as of `78e2e75`, plus documentation and `scripts/package.py`. Environment:
Node.js 22.22.2, pnpm 11.19.0, PostgreSQL 16.13, Next.js 16.3.5, Prisma 6.19.3,
Chromium 141.0.7390.37 (the headless shell pinned by playwright-core 1.56.1).

| Gate (CI order)                   | Result                                                                                                                                                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`  | Passed                                                                                                                                                                                                     |
| `pnpm typecheck`                  | Passed (application, scripts and tests)                                                                                                                                                                    |
| `pnpm lint`                       | Passed: 0 errors, 19 warnings. The warnings are the same file and rule pairs the original sources produce under this configuration (image elements, location assignment, set-state-in-effect); none is new |
| `pnpm format:check`               | Passed                                                                                                                                                                                                     |
| `pnpm test`                       | 91 passed, 0 failed, 0 skipped: domain, calendar core, fetcher, fixtures, anonymizer, property-based, PGlite database, operations, redaction and copy tests                                                |
| `PROPERTY_RUNS=1000` property run | 3 passed (randomized histories, export properties, conflict pairs)                                                                                                                                         |
| `pnpm test:integration`           | 14 passed, 0 failed, 0 skipped, with `REQUIRE_INTEGRATION_TESTS=1`, on PostgreSQL 16 through a `NOSUPERUSER NOBYPASSRLS` role; no test databases left behind                                               |
| `pnpm build`                      | Passed                                                                                                                                                                                                     |
| `pnpm test:browser`               | 6 passed, 0 failed, 0 skipped, with `REQUIRE_BROWSER_TESTS=1`, against the production build at 1440 × 1000 and 390 × 844                                                                                   |
| `pnpm audit:deps`                 | Passed: no high or critical advisory except the recorded exception GHSA-ggr8-5vv4-36mx                                                                                                                     |
| `pnpm package`                    | The archive contains exactly the tracked files                                                                                                                                                             |

The browser check for the policy question was also run against a build with
the reopened-policy defect reintroduced, and failed as it should (the
owner-closure label came back as `RESERVATION` instead of the stored
`UNKNOWN`), then passed again with the fix.

### Manual browser walkthrough

Before the browser checks were automated, the rebuilt interface was driven in
Chromium against a seeded PostgreSQL database, in shadow mode and then live,
at desktop and phone widths: sign-in, every workspace section, the policy
question for two platforms, block and overlap details, a flagged block, holds
with and without overlaps, direct reservation, connection detail and connect
form, go-live with `pnpm calendar:mode`, the live export link (15 events with
buffer UIDs), turnover tasks, release with confirmation, 24-hour restore, a
released stay returning in its calendar, and notifications. It found the
defects fixed in `2649203`: the reopened-policy answer, a pre-selected
"all guest reservations" answer, an unrecorded "classify each block myself"
answer, shadow-mode copy that promised export publication, unexplained review
flags, and unclear notification text.

### Not verified here

- Hosted deployment, the external clock, monitors and alert delivery.
- Backups against a hosted database and bucket, and a timed restore drill
  (the backup and restore commands were exercised locally during
  development).
- Real platform exports (none are committed yet), live SMS, email, OTA bridge,
  photo storage, AI and push providers.
- Load, cross-browser, screen-reader and independent security review.

## Earlier: September 23, 2026

The original delivery was verified with a production build, 19 focused tests
(including both original SQL migrations in PGlite), and browser inspection of
the unconfigured startup screen at 1440 × 900 and 390 × 844. No production
database or provider credentials were supplied then either.
