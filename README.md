# Airbnb Automation

A standalone short-term rental operations application: master calendar, guest inbox, cleaning coordination, property knowledge, controlled automation, and operational reporting. This is the new application source, separate from the previous static UI demonstration. It is not affiliated with Airbnb, Inc.

Built with Next.js App Router, TypeScript, Prisma, and PostgreSQL. The interface offers dark, OLED, and light themes, responsive layouts, keyboard navigation, a command palette, and contextual action history. Persistent workflows run against PostgreSQL; external actions use actual provider adapters. There is no seeded business data, mock delivery success, or built-in demo account.

## Start here

The source ZIP can be extracted into a new GitHub repository. Upload the **contents** of this directory, including the lockfile, migrations, and configuration files. Do not upload `.env`, `node_modules`, or `.next`.

1. Install Node.js **22.14–24.x**, pnpm **11.19.0**, and provision PostgreSQL. Use a dedicated database and the separate owner/runtime roles described in [Deployment](docs/DEPLOYMENT.md).
2. Install dependencies and prepare configuration:

   ```sh
   pnpm install --frozen-lockfile
   cp .env.example .env
   ```

3. Replace every required placeholder in `.env`. Generate independent random encryption, authentication, and cron secrets. `APP_URL` must match the origin used in the browser. The encryption key is 32 random bytes, encoded as base64:

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
   ```

   Store it as `ENCRYPTION_KEYS={"v1":"YOUR_BASE64_KEY"}` with `ENCRYPTION_KEY_ID=v1`. Generate separate values for `AUTH_SECRET` and `CRON_SECRET`; do not reuse the encryption key.

4. Apply both migrations using the privileged migration connection, then apply the runtime grants in [Deployment](docs/DEPLOYMENT.md):

   ```sh
   pnpm db:migrate
   pnpm db:generate
   ```

5. Set `BOOTSTRAP_EMAIL`, `BOOTSTRAP_PASSWORD` (at least 14 characters), `BOOTSTRAP_NAME`, and `BOOTSTRAP_WORKSPACE`. Create the initial owner and validate configuration:

   ```sh
   pnpm setup:owner
   pnpm check:env
   ```

6. Remove `BOOTSTRAP_*` values after setup. Start the web application and, in a separate terminal, the local scheduler:

   ```sh
   pnpm dev
   ```

   ```sh
   pnpm worker
   ```

7. Open `http://localhost:3000`, sign in, add a property, fill in its structured manual, and connect its calendar feeds. Copy the channel-specific export URL back into that channel's calendar-import settings. Configure providers before enabling the workflows that use them.

The owner bootstrap creates an empty workspace and editable FAQ rules in **draft** mode. All automation starts **paused**, each automation category starts disabled, and AI confidence starts at **98%**. Enable categories deliberately after validating them against your own accounts and data.

## Included workflows

| Area           | Behavior                                                                                                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Calendar       | Month, week, and agenda views; listing colors; source freshness; direct reservations; date blocks; buffer hatching; booking details; conflict review; iCal import and tokenized export |
| Inbox          | Guest threads, filters, booking context, repeat-stay count when identity is known, rule/AI drafts, edit/approve/dismiss, manual takeover, delivery status                              |
| Cleaning       | Six stages, listing-scoped cleaner assignment, SMS magic links, acceptance-gated code access, private photo evidence, host verification, overdue escalation                            |
| Properties     | Structured Wi-Fi/check-in/parking/washroom/rules, private photographs, encrypted door codes, time zone, checkout timing, buffers, calendar connections                                 |
| Automation     | Global pause, independent categories, ordered keyword rules, confidence gate, sensitive-intent escalation, action explanations                                                         |
| Insights       | Recorded occupancy, prorated known revenue with price coverage, response latency, import success rate, verification turnaround, CSV export                                             |
| Administration | Host/co-host access, password changes and revocation, push subscriptions, bridge configuration, append-only audit history, uncertain-action reconciliation                             |

## Provider configuration

Provider credentials are server-side environment variables. The settings screen's “Configured” label means credentials are present; it is not a connectivity test.

| Capability                    | Configuration                                                                                                                 |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Calendar imports              | `ICAL_ALLOWED_HOSTS`; approved HTTPS source feed URLs entered per property                                                    |
| Cleaner SMS                   | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`                                                               |
| Direct guest email            | `RESEND_API_KEY`, verified `EMAIL_FROM`                                                                                       |
| Native OTA messages           | Your authorized channel-provider bridge, `MESSAGING_ALLOWED_HOSTS`, per-platform endpoint and HMAC secret in Settings         |
| AI replies / command fallback | `OPENAI_API_KEY`; optionally `OPENAI_MODEL`, `AI_TIMEOUT_MS`                                                                  |
| Private photos                | `SUPABASE_URL`, server-only `SUPABASE_SERVICE_ROLE_KEY`, a **private** `STORAGE_BUCKET`                                       |
| Browser push                  | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`; each host grants browser permission                                 |
| Optional error monitoring     | `SENTRY_DSN`, optionally `NEXT_PUBLIC_SENTRY_DSN`; source-map upload additionally uses Sentry organization/project/auth token |

See [Integrations](docs/INTEGRATIONS.md) for the signed bridge contract and [Deployment](docs/DEPLOYMENT.md) for Vercel, database roles, storage, secrets, and scheduling.

## Important operating boundaries

- Calendar import polling targets 60–120 seconds while the scheduler is healthy and within capacity. A channel decides when it refreshes the app's exported calendar. The app cannot guarantee that another platform blocks inventory immediately or prevent every booking during a platform's refresh delay.
- Calendar feeds generally supply availability, not complete guest identity, price, or messages. The application does not invent missing data; host enrichment and authorized messaging integration are separate steps.
- Native Airbnb/Vrbo/Expedia/Booking.com messaging requires access through an authorized provider. This repository includes a signed integration boundary, not private OTA credentials or an undisclosed API bypass.
- A sent SMS or guest message cannot be recalled. Unconfirmed external outcomes are held for review instead of automatically resent. Pausing automation stops work that has not crossed the external-send boundary; it cannot undo an in-flight provider request.
- Cleaner access is assignment-scoped and includes today's assigned jobs in each property's local time zone. Cleaning events can be reconstructed with `pnpm events:replay`; this never repeats external sends. General undo, bulk data retention tooling, and phase-5 upsell commerce are not implemented.
- Credentials, deployment, live provider verification, load testing, a complete accessibility audit, and independent security review remain operator work. This package does not claim those have already occurred.

The detailed specification mapping, including partial requirements, is in [Coverage](docs/COVERAGE.md).

## Engineering map

```text
src/app/                    App Router pages and API entry point
src/components/             Product surfaces and reusable accessible controls
src/lib/                    Shared domain rules, client types, fetch helpers
src/server/router.ts        Validation, authentication, roles, API boundaries
src/server/services/        Calendar, cleaning, messaging, jobs, storage, insights
src/server/integrations/    Real provider adapters and protected outbound HTTP
prisma/                     Data model and versioned SQL migrations
scripts/                    Owner setup, configuration checks, worker, recovery
tests/                      Focused domain and database security checks
docs/                       Deployment, integration contract, operations, coverage
```

Transactions set a local PostgreSQL workspace scope before reading tenant data. Database constraints protect cross-tenant references and workflow invariants. Domain changes, audit records, and outbox work are committed together where appropriate. Workers claim leased jobs, evaluate current authorization and automation settings, and record provider outcomes separately from intent.

Useful commands:

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm start
pnpm package
```

Read [Operations and security](docs/OPERATIONS.md) before enabling automatic sends or accepting real guest information. The original user specification is preserved at [PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md).
