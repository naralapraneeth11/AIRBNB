# Deployment

The supported production target is a Next.js application on Vercel with managed PostgreSQL, private Supabase Storage, and an external one-minute clock. `pnpm worker` runs the same scheduler tick for local development or as a dedicated process; it is not a second application architecture.

Each step below that closes a Phase 0 gate has a record in [RELEASE_GATES.md](RELEASE_GATES.md). Fill it in as you go.

## 1. PostgreSQL roles, migrations and grants

Use a dedicated database per environment. The schema owner applies migrations; the application connects as a non-owner `NOSUPERUSER NOBYPASSRLS` role. Never use a managed provider's administrator or service role for `DATABASE_URL`. The server checks the role's superuser and bypass-RLS attributes and the database's environment marker before any tenant access; `pnpm check:env` also checks forced row-level security on every tenant table.

The examples use `airbnb` as the database and `airbnb_app` as the runtime role. Create the role as an administrator and supply its password through your provider's secret interface, not a committed SQL literal:

```sql
CREATE ROLE airbnb_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOREPLICATION NOBYPASSRLS;

GRANT CONNECT ON DATABASE airbnb TO airbnb_app;

-- This application expects a dedicated schema/database.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
```

With the schema owner as `DIRECT_URL`, apply the migrations:

```sh
pnpm db:migrate
```

This applies, in order, `202609210001_initial`, `202609210002_security` (forced RLS, tenant-aware foreign keys, workflow checks, immutable-history triggers), `202609270001_operations_foundation` (scheduler lease and ticks, environment marker, backup evidence), `202609270002_calendar_correctness` (the Phase 1 calendar model) `202609280001_accounts` (pending sign-ups, password reset links and guided setup progress; additive only, so it is safe to run before or after the code that uses it) and `202610070001_property_removal` (a calendar-link state for links paused by removing their property; constraint changes only, safe in either order: until it runs, removing a property fails and changes nothing). Do not substitute `prisma db push`; it does not install the custom SQL protections.

`202609270002_calendar_correctness` rebuilds the calendar model under the MIG 01 pre-launch exception. On a database that already exists, run it only after the product owner's written confirmation that no real host data exists and a verified backup, recorded in [RELEASE_GATES.md](RELEASE_GATES.md#mig-01-written-confirmation). `pnpm db:prelaunch-check` prints the row counts that confirmation relies on. The migration refuses to run over legacy calendar rows and keeps existing export links and cleaning tasks.

Then apply the shipped least-privilege grants, still as the schema owner:

```sh
psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -v runtime_role=airbnb_app \
  -f prisma/grants/runtime-role.sql
```

The script is idempotent and revokes before it grants, so re-run it after every migration. It gives the runtime role only what the application uses: calendar and cleaning history without `DELETE`, append-only audit and domain events, update-only access to the scheduler lease, and read-only access to the environment marker and backup evidence. It never grants `_prisma_migrations`, ownership, schema creation, or default privileges on future tables.

Mark the database with the environment it belongs to (SEC 04). Only the schema owner can write the marker:

```sh
pnpm db:mark-environment production --by "your name"
```

Use `staging`, `development` or `test` for the others. Changing an existing marker requires naming the current one (`--replace production`), so a typo cannot re-label production.

Verify the runtime connection:

```sql
SELECT current_user, rolsuper, rolbypassrls
FROM pg_roles WHERE rolname = current_user;

SELECT c.relname, pg_get_userbyid(c.relowner) AS owner,
       c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname IN
  ('Listing', 'AvailabilityBlock', 'Reservation', 'Message', 'CleaningTask', 'AuditLog');
```

`rolsuper` and `rolbypassrls` must both be false, the table owners must differ from the runtime role, and both RLS flags must be true. Tenant tables return no rows until a transaction sets `app.workspace_id`. Authentication and capability lookup tables are deliberately server-only and outside tenant RLS so a credential can resolve its workspace; they are not a public database API.

`DATABASE_URL` may use your provider's Prisma-compatible pooled connection. Set the pool size explicitly per process (section 2 of the specification): `DATABASE_POOL_SIZE` for the web application and `WORKER_DATABASE_POOL_SIZE` for `pnpm worker`. Unset, they default to 1 per serverless function on Vercel, 3 for a local web server and 4 for the worker. Keep function concurrency × pool size within the database plan's connection limit.

Keep owner credentials in a controlled migration environment, never in the web deployment. Production sets `DIRECT_URL` to a direct **runtime-role** connection; only the migration and setup process overrides it with the schema owner.

## 2. Environment and owner bootstrap

Copy `.env.example` locally and configure the required values:

- `APP_ENVIRONMENT`: `production`, `staging`, `preview`, `development` or `test`. It must match the database marker; a `preview` deployment may use a database marked `staging` and nothing else.
- `APP_URL`: `http://localhost:3000` locally and the exact HTTPS canonical origin in production. Mutation origin checks reject any other origin, so do not sign in through a preview URL while `APP_URL` points to production.
- `AUTH_SECRET`, `CRON_SECRET` and `MONITOR_SECRET`: at least 32 random characters each, generated separately, different in every environment.
- `ENCRYPTION_KEYS`: a JSON map of key identifiers to 32-byte base64 keys; `ENCRYPTION_KEY_ID` chooses the key for new writes.

The administrative scripts load `.env`; platform environment variables supply values in deployment.

Optional account settings (AUTH 01, AUTH 03):

- `RESEND_API_KEY` and `EMAIL_FROM` (an address on a domain verified in Resend) turn on "Forgot your password?". Reset links are single use, last 30 minutes and sign the account out everywhere.
- `SIGNUP_ENABLED=true` additionally opens self-service sign-up at `/signup`. Leave it unset for a supervised demo: you create each account with `pnpm setup:owner`, and nobody else can register. In `development` and `test` only, account emails without Resend are printed to the server log instead of sent.
- `NEXT_PUBLIC_BRAND_NAME` sets the visible product name (default "Airbnb Automation"). It is built into the pages, so redeploy after changing it. Export links and other identifiers never change with it.

In the controlled setup environment, set the four `BOOTSTRAP_*` fields and run `pnpm setup:owner` once (again with different values for each additional account you provision yourself). An existing owner email makes bootstrap fail without changing that account. It creates a workspace (in calendar shadow mode), the owner membership, paused automation and four draft response rules. Remove bootstrap secrets immediately afterward, then run `pnpm check:env` with the runtime connection: it checks encryption, the role's attributes, forced RLS, the pool sizes and the environment marker.

Never commit `.env`, and never copy production guest data into staging or preview.

## 3. Photo storage

Create a **private** Supabase Storage bucket named `airbnb-private`, or set `STORAGE_BUCKET` to a different private bucket, separate per environment. Storage is required even when the database is hosted elsewhere. Configure `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` only on the server.

The browser uploads to the application, never directly with the service key. Uploads accept JPEG, PNG and WebP up to 4 MB. The server decodes, bounds pixel count, removes metadata by re-encoding, and stores a WebP image with its SHA-256. Authenticated asset routes enforce workspace and cleaner scope and audit reads. Do not make the bucket public or add anonymous-read policies.

Photo upload failure keeps cleaning unverified. Validate a real upload and authenticated retrieval before assigning live jobs.

## 4. Vercel

1. Import the repository as a Next.js project. Use Node.js 22 or 24, install with `pnpm install --frozen-lockfile`, and build with `pnpm build`.
2. Add the environment variables per Vercel environment: production values only in Production, staging values in Preview (with `APP_ENVIRONMENT=preview`). Set the canonical HTTPS `APP_URL`. Do not expose provider, encryption, database or HMAC secrets with a `NEXT_PUBLIC_` prefix; `NEXT_PUBLIC_SENTRY_DSN` is the only public telemetry setting.
3. Apply migrations and grants from the controlled release process before directing traffic to code that needs them. Web builds never run owner-credential migrations.
4. Deploy. Verify `GET /api/health` (database reachable), `GET /api/health/operations?check=environment` with the monitor secret, sign-in, workspace reads, one reversible property change and one real calendar check.

`vercel.json` declares no cron jobs: the cadence Vercel Cron offers depends on the plan, and calendar protection needs one minute.

## 5. Scheduler clock and monitors

An external clock calls `POST /api/cron` with `Authorization: Bearer <CRON_SECRET>` once a minute (ARCH 03). Each tick claims bounded durable work under a database lease, records what it claimed, completed and left behind in `SchedulerTick`, and releases the lease (OPS 01). A second caller during a tick is recorded as skipped and does no work, so the clock and `pnpm worker` can both run safely.

Deploy the Cloudflare Worker in [`ops/clock`](../ops/clock/README.md), one per environment, or any scheduler that can send that authenticated request every minute. A deployed page does not prove the scheduler runs; the monitors do.

Configure four HTTP monitors per environment against `/api/health/operations`, each sending `Authorization: Bearer <MONITOR_SECRET>`: `check=heartbeat`, `check=progress`, `check=backups` and `check=environment`. Each returns 200 or 503 with timestamps and counts only, never tenant data. Thresholds and what each detects are in [`ops/clock/README.md`](../ops/clock/README.md#monitor).

For local operation, run `pnpm worker` beside `pnpm dev`. Calendar checks continue while messaging and cleaning automation are paused, so availability stays observable.

## 6. Staging and previews

Staging is a separate project with its own database (marked `staging`), storage bucket, clock, monitors and secrets. Preview deployments use the staging database with `APP_ENVIRONMENT=preview`; the application refuses to serve a preview from a production database, and refuses `APP_ENVIRONMENT=production` inside a Vercel preview. Provider accounts should be test accounts or approved destinations where the provider supports them. The checklist is in [RELEASE_GATES.md](RELEASE_GATES.md#staging-isolation).

## 7. Backups

Nightly backups of Postgres, storage objects and encryption keys run as three GitHub Actions jobs in `.github/workflows/backup.yml`, off until configured. Setup, the offline key pair, restore and the drill are in [OPERATIONS.md](OPERATIONS.md#backups-and-restore). Create the backup role as an administrator:

```sh
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -v backup_role=hostsphere_backup \
  -v database=airbnb -f prisma/grants/backup-role.sql
```

## 8. Calendar go-live

Every workspace starts in calendar **shadow mode** (REL 01): checks run and decisions are recorded, but export links answer "not active yet", and calendar alerts and turnover changes are withheld. Platforms keep their current calendars meanwhile.

After seven representative days, print the review with `pnpm calendar:shadow-report <workspace-id> --days 7 --markdown`, adjudicate every item against the platforms' own calendars, and record it in [RELEASE_GATES.md](RELEASE_GATES.md#shadow-review). Then:

```sh
pnpm calendar:mode <workspace-id> LIVE --reviewed "<link to the review>"
```

This serves export links and creates the turnover work shadow mode withheld, one property at a time; an interrupted run is safe to repeat. `pnpm calendar:mode <workspace-id> SHADOW --reason "<why>"` stops new effects without removing work already created. Only after going live should the host import each connection's export link into its platform.

## 9. Bring providers online

Follow [INTEGRATIONS.md](INTEGRATIONS.md) to configure Twilio, Resend, OpenAI, web push and an authorized OTA bridge. A "Configured" indicator only detects environment values; verify actual receipts separately.

Start with rules in `DRAFT`, AI disabled and global automation paused. Validate calendar checks first, then cleaning, then guest-message drafts and approvals. Enable automatic sends only after checking the exact provider accounts and the property manual the responder uses.

## 10. Release verification and rollback

Before a release, run the same gates CI runs (see [CONTRIBUTING.md](../CONTRIBUTING.md)): `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm test:integration`, `pnpm build`, `pnpm test:browser` and `pnpm audit:deps`. Automated checks do not replace a provider-connected acceptance pass in staging: tenant isolation with runtime credentials, scheduler progress, photo access, cleaner acceptance and draft approval.

Record the deployed commit, the applied migrations, the capability table version (`CAPABILITIES_VERSION`), workspace calendar modes, and the rollback procedure. Keep a verified backup and its encryption keys before any schema change. Rolling back application code does not reverse migrations or recall external messages. While investigating a regression, use the global automation pause, return an affected workspace to calendar shadow mode, stop the clock if necessary, and preserve audit and outbox records for reconciliation.
