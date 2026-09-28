# Airbnb Automation

A standalone short-term rental operations application: master calendar, guest inbox, cleaning coordination, property knowledge, controlled automation, and operational reporting. It implements the Hostsphere Product and Engineering Specification v1.1; the Phase 0 and Phase 1 gates are tracked with their evidence in [RELEASE_GATES.md](docs/RELEASE_GATES.md). It is not affiliated with Airbnb, Inc.

Built with Next.js App Router, TypeScript, Prisma, and PostgreSQL. The interface offers dark, OLED, and light themes, responsive layouts, keyboard navigation, a command palette, and contextual action history. Persistent workflows run against PostgreSQL; external actions use actual provider adapters. There is no seeded business data, mock delivery success, or built-in demo account.

## Start here

1. Install Node.js **22.14–24.x**, pnpm **11.19.0** (`corepack enable` selects it), and provision PostgreSQL with separate owner and runtime roles as described in [Deployment](docs/DEPLOYMENT.md). Install `psql` for the grant scripts.
2. Install dependencies and prepare configuration:

   ```sh
   pnpm install --frozen-lockfile
   cp .env.example .env
   ```

3. Replace every required placeholder in `.env`. Set `APP_ENVIRONMENT=development`. Generate independent random values for `AUTH_SECRET`, `CRON_SECRET` and `MONITOR_SECRET`; `APP_URL` must match the origin used in the browser. The encryption key is 32 random bytes, encoded as base64:

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
   ```

   Store it as `ENCRYPTION_KEYS={"v1":"YOUR_BASE64_KEY"}` with `ENCRYPTION_KEY_ID=v1`. Never reuse one secret for another purpose.

4. With the schema owner as `DIRECT_URL`, apply the migrations and the runtime grants, and mark the database's environment:

   ```sh
   pnpm db:migrate
   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -v runtime_role=airbnb_app -f prisma/grants/runtime-role.sql
   pnpm db:mark-environment development --by "your name"
   pnpm db:generate
   ```

5. Set `BOOTSTRAP_EMAIL`, `BOOTSTRAP_PASSWORD` (at least 14 characters), `BOOTSTRAP_NAME`, and `BOOTSTRAP_WORKSPACE`, create the initial owner, then switch `DIRECT_URL` to the runtime role and validate configuration:

   ```sh
   pnpm setup:owner
   pnpm check:env
   ```

6. Remove the `BOOTSTRAP_*` values. Start the web application and, in a separate terminal, the scheduler:

   ```sh
   pnpm dev
   ```

   ```sh
   pnpm worker
   ```

7. Open `http://localhost:3000`, sign in, add a property, fill in its structured manual, and connect its calendars. Answer each connection's policy question on the calendar. The workspace starts in calendar **shadow mode**: decisions are recorded but export links, calendar alerts and turnover changes wait until you go live after the shadow review ([Deployment §8](docs/DEPLOYMENT.md#8-calendar-go-live)). Then import each connection's export link into its platform.

The owner bootstrap creates an empty workspace and editable FAQ rules in **draft** mode. All automation starts **paused**, each automation category starts disabled, and AI confidence starts at **98%**. Enable categories deliberately after validating them against your own accounts and data.

## Included workflows

| Area           | Behavior                                                                                                                                                                                                                                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Calendar       | Month, week, and agenda views; "Needs your decision" for stays awaiting a reopen decision, policy questions, unknown and flagged blocks, and overlap cases; holds and direct reservations with overlap acknowledgement; buffer days; a release review with 24-hour restore; destination-specific export links; shadow mode |
| Inbox          | Guest threads, filters, reservation context, repeat-stay count when identity is known, rule/AI drafts, edit/approve/dismiss, manual takeover, delivery status                                                                                                                                                              |
| Cleaning       | Six stages, turnovers only for reservations, cancelled and superseded jobs, listing-scoped cleaner assignment, SMS magic links, acceptance-gated code access, private photo evidence, host verification, overdue escalation                                                                                                |
| Properties     | Structured Wi-Fi/check-in/parking/washroom/rules, private photographs, encrypted door codes, time zone, checkout timing, buffers, calendar connections with check evidence and export-link retrievals                                                                                                                      |
| Automation     | Global pause, independent categories, ordered keyword rules, confidence gate, sensitive-intent escalation, action explanations                                                                                                                                                                                             |
| Insights       | Recorded occupancy, prorated known revenue with price coverage, response latency, calendar check reliability, verification turnaround, CSV export                                                                                                                                                                          |
| Administration | Host/co-host access, password changes and revocation, push subscriptions, bridge configuration, append-only audit history, uncertain-action reconciliation                                                                                                                                                                 |

## Provider configuration

Provider credentials are server-side environment variables. The settings screen's "Configured" label means credentials are present; it is not a connectivity test.

| Capability                    | Configuration                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Calendar imports              | Platform links are checked against built-in domain rules; `ICAL_ALLOWED_HOSTS` optionally restricts Google and other calendars; `FETCHER_CONTACT` |
| Scheduler and monitoring      | An external clock sending `CRON_SECRET` (see [`ops/clock`](ops/clock/README.md)); monitors sending `MONITOR_SECRET`                               |
| Cleaner SMS                   | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`                                                                                   |
| Direct guest email            | `RESEND_API_KEY`, verified `EMAIL_FROM`                                                                                                           |
| Native OTA messages           | Your authorized channel-provider bridge, `MESSAGING_ALLOWED_HOSTS`, per-platform endpoint and HMAC secret in Settings                             |
| AI replies / command fallback | `OPENAI_API_KEY`; optionally `OPENAI_MODEL`, `AI_TIMEOUT_MS`                                                                                      |
| Private photos                | `SUPABASE_URL`, server-only `SUPABASE_SERVICE_ROLE_KEY`, a **private** `STORAGE_BUCKET`                                                           |
| Browser push                  | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`; each host grants browser permission                                                     |
| Optional error monitoring     | `SENTRY_DSN`, optionally `NEXT_PUBLIC_SENTRY_DSN`; source-map upload additionally uses Sentry organization/project/auth token                     |

See [Integrations](docs/INTEGRATIONS.md) for calendar capabilities, export links and the signed bridge contract, and [Deployment](docs/DEPLOYMENT.md) for Vercel, database roles, staging, storage, secrets, scheduling and backups.

## Important operating boundaries

- Calendars are checked about every 15 minutes, and every 5 minutes when an arrival or departure is near. A platform decides when it refreshes its copy of an exported calendar, often hours later. The app cannot guarantee that another platform blocks inventory immediately or prevent every booking during a platform's refresh delay.
- The calendar never reopens dates on its own. A failed, partial or empty check keeps existing protection; a stay that disappears or is cancelled waits for the host's decision (LIFE 01).
- Calendar feeds generally supply availability, not guest identity, price, or messages, and they may not say whether a block is a guest stay. The application does not invent missing data: unclear blocks stay Unknown and protected until the host answers.
- Native Airbnb/Vrbo/Expedia/Booking.com messaging requires access through an authorized provider. This repository includes a signed integration boundary, not private OTA credentials or an undisclosed API bypass.
- A sent SMS or guest message cannot be recalled. Unconfirmed external outcomes are held for review instead of automatically resent. Pausing automation stops work that has not crossed the external-send boundary; it cannot undo an in-flight provider request.
- Cleaner access is assignment-scoped and includes today's assigned jobs in each property's local time zone. Cleaning events can be reconstructed with `pnpm events:replay`; this never repeats external sends. General undo, bulk data retention tooling, and phase-5 upsell commerce are not implemented.
- Credentials, deployment, live provider verification, load testing, a complete accessibility audit, and independent security review remain operator work. This repository does not claim those have already occurred; [RELEASE_GATES.md](docs/RELEASE_GATES.md) records what is done and what remains.

The mapping to the original product brief, including partial requirements, is in [Coverage](docs/COVERAGE.md).

## Engineering map

```text
src/app/                    App Router pages and the API entry point
src/components/             Product surfaces and reusable accessible controls
src/domain/calendar/        Pure calendar core: ten stages, no I/O, supplied clock
src/domain/cleaning/        Turnover planning rules
src/lib/                    Shared domain rules, client types, wording, fetch helpers
src/server/router.ts        Validation, authentication, roles, API boundaries
src/server/routes/          Calendar and operations routes
src/server/calendar/        Fetching, fenced runs, commits, exports, host actions
src/server/services/        Cleaning, messaging, scheduler jobs, storage, insights
src/server/integrations/    Real provider adapters and protected outbound HTTP
prisma/                     Data model, versioned SQL migrations, role grants
scripts/                    Setup, environment marker, worker, backups, calendar mode, reports
ops/clock/                  External one-minute scheduler clock
tests/                      Unit, fixture, property, integration and browser tests
docs/                       Deployment, integrations, operations, gates, coverage
```

Transactions set a local PostgreSQL workspace scope before reading tenant data. Database constraints protect cross-tenant references and workflow invariants. Domain changes, audit records, and outbox work are committed together where appropriate. Workers claim leased jobs, evaluate current authorization and automation settings, and record provider outcomes separately from intent.

Useful commands (the gates CI runs are listed in [CONTRIBUTING.md](CONTRIBUTING.md)):

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm test:integration      # needs TEST_DATABASE_URL
pnpm build
pnpm test:browser          # after a build; needs TEST_DATABASE_URL
pnpm package
```

Read [Operations and security](docs/OPERATIONS.md) before enabling automatic sends or accepting real guest information. Report vulnerabilities as described in [SECURITY.md](SECURITY.md); changes are listed in [CHANGELOG.md](CHANGELOG.md). The original product brief is preserved at [PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md).
