# Deployment

The supported production target is a Next.js application on Vercel with managed PostgreSQL, private Supabase Storage, and Vercel Cron. `pnpm worker` runs the same scheduler for local development or a dedicated process when cron capacity is insufficient; it is not a second application architecture.

## 1. PostgreSQL roles and migrations

Use a dedicated database. The schema owner applies migrations; the application connects as a non-owner `NOSUPERUSER NOBYPASSRLS` role. Never use a managed provider's administrator or service role for `DATABASE_URL`. The server checks superuser and bypass-RLS attributes before tenant access; `pnpm check:env` also checks forced row-level security on key tables.

Example below uses `airbnb` as the database name and `airbnb_app` as the runtime role. Adapt the names to your database. Run the role creation as an administrator; run grants after both migrations as the schema owner. Supply the runtime password through your database administrator or secret-management interface rather than committing a SQL password literal.

```sql
CREATE ROLE airbnb_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOREPLICATION NOBYPASSRLS;

GRANT CONNECT ON DATABASE airbnb TO airbnb_app;
GRANT USAGE ON SCHEMA public TO airbnb_app;

-- This application expects a dedicated schema/database.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM airbnb_app;
```

Use your schema-owner connection as `DIRECT_URL` while running:

```sh
pnpm db:migrate
```

This applies the initial schema and the second migration containing forced RLS, tenant-aware foreign keys, workflow checks, and immutable-history triggers. Do not substitute `prisma db push`; it does not install the custom SQL protections.

Then grant only the application tables it uses:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  "Workspace", "User", "Membership", "Session", "RateLimit",
  "Listing", "SyncSource", "SyncRun", "Booking", "Cleaner",
  "CleaningTask", "MagicLink", "Asset", "Thread", "Message",
  "AutomationSettings", "AutomationRule", "Outbox", "Notification",
  "PushSubscription", "Integration"
TO airbnb_app;

GRANT SELECT, INSERT ON TABLE "AuditLog", "DomainEvent" TO airbnb_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "AuditLog", "DomainEvent"
FROM airbnb_app;
```

There are no serial-ID sequences in the current schema. Do not grant the runtime role access to `_prisma_migrations`, table ownership, schema creation, or membership in the owner role. Do not add blanket default grants to future tables: review their tenant policy and grant only what the next release needs.

Verify the runtime connection:

```sql
SELECT current_user, rolsuper, rolbypassrls
FROM pg_roles WHERE rolname = current_user;

SELECT c.relname, pg_get_userbyid(c.relowner) AS owner,
       c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname IN
  ('Listing', 'Booking', 'Message', 'CleaningTask', 'AuditLog');
```

`rolsuper` and `rolbypassrls` must both be false, the five table owners must differ from the runtime role, and both RLS flags must be true. Application operational tables return no tenant rows until a transaction sets `app.workspace_id`. Authentication/capability lookup tables are deliberately server-only and outside tenant RLS so a credential can resolve its workspace; they are not a public database API.

`DATABASE_URL` may use your provider's Prisma-compatible pooled connection. Migrations and bootstrap use a direct owner connection. Use TLS according to the provider's configuration. Set connection limits within the database plan's capacity; Vercel function concurrency can multiply Prisma connection pools.

Keep privileged owner credentials in a migration/setup environment, not the production web function. Production can set `DIRECT_URL` to a direct **runtime-role** connection; only the controlled migration/bootstrap process overrides it with the schema-owner connection. The application serves requests using `DATABASE_URL`.

## 2. Environment and owner bootstrap

Copy `.env.example` locally and configure required secrets. `AUTH_SECRET` and `CRON_SECRET` each require at least 32 random characters. `ENCRYPTION_KEYS` is a JSON map of version identifiers to 32-byte base64 keys; `ENCRYPTION_KEY_ID` chooses the key for new writes.

The administrative scripts load `.env`; platform environment variables can supply values in deployment. Use `APP_URL=http://localhost:3000` locally and the exact HTTPS canonical origin in production. Avoid signing in through a preview origin while `APP_URL` points to production: mutation origin checks will reject it.

In the controlled setup environment, set the four `BOOTSTRAP_*` fields and run `pnpm setup:owner` once. An existing owner email makes bootstrap fail without changing that account. It creates a workspace, owner membership, paused controls, and four draft response rules. Remove bootstrap secrets immediately afterward. Re-run `pnpm check:env` with the runtime connection to check encryption and database protections.

Do not commit `.env` or copy production guest data into preview deployments. Preview environments need an isolated database, storage bucket, provider accounts where supported, and separate secrets.

## 3. Photo storage

Create a **private** Supabase Storage bucket named `airbnb-private`, or set `STORAGE_BUCKET` to a different private bucket. Storage is required even when the database is hosted on Neon. Configure `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` only on the server.

The browser uploads to the application, never directly with the service key. Uploads accept JPEG, PNG, and WebP up to 4 MB. The server decodes, bounds pixel count, removes metadata by re-encoding, and stores a WebP image. Authenticated asset routes enforce workspace/cleaner scope and audit reads. Do not make the bucket public or add permissive anonymous-read policies.

Photo upload failure keeps cleaning unverified. Validate real upload and authenticated retrieval before assigning live jobs.

## 4. Vercel

1. Import the new repository as a Next.js project. Select this directory as the root if it is nested in a larger repository. Use Node.js 22 or 24, install with `pnpm install --frozen-lockfile`, and build with `pnpm build`.
2. Add runtime secrets to the production environment. Set the canonical HTTPS `APP_URL`. Do not expose provider, encryption, database, or HMAC secrets with a `NEXT_PUBLIC_` prefix. `NEXT_PUBLIC_SENTRY_DSN` is the sole optional public telemetry setting.
3. Apply versioned migrations from a controlled release process before directing traffic to code that needs them. This repository does not run owner-credential migrations automatically on every web build.
4. Deploy. Verify `GET /api/health`, sign-in, workspace reads, one reversible property change, and one real calendar import in the deployed environment.
5. Check the Vercel plan supports the configured one-minute cron schedule and 60-second function duration. `vercel.json` invokes `/api/cron`; Vercel must send `Authorization: Bearer <CRON_SECRET>`.

The cron route rejects missing or invalid authentication. Monitor actual cron invocation and sync timestamps; a deployed page alone does not prove the worker is running. Cron runs use bounded work, persisted scheduling, database leases, and idempotency keys. Larger portfolios may need increased worker throughput before the 60–120 second target can be maintained; the current code is not capacity-certified.

For local operation, keep `pnpm worker` running alongside `pnpm dev`. It calls the same cron function once per minute. Do not rely on an open browser to run scheduled work. Source import polling continues when automatic messaging and cleaning are paused so availability remains observable.

## 5. Bring providers online

Follow [INTEGRATIONS.md](INTEGRATIONS.md) to configure Twilio, Resend, OpenAI, web push, and an authorized OTA bridge. Use provider testing environments/approved destinations where available. A “Configured” indicator only detects environment values; verify actual receipts separately.

Start with rules set to `DRAFT`, AI disabled, and global automation paused. Validate feeds first, then cleaning, then guest-message draft/approval workflows. Enable automatic sends only after checking the exact provider accounts and the property manual used by the responder.

## 6. Release verification and rollback

Run `pnpm typecheck`, `pnpm test`, and `pnpm build` before a release. The focused automated checks do not replace a provider-connected acceptance pass. Confirm tenant isolation with runtime credentials, cron progress, photo access, cleaner acceptance, and host draft approval in staging.

Record the deployed commit and migration names. Keep a tested PostgreSQL backup and corresponding encryption keys before schema changes. Prefer backward-compatible migrations; rolling back application code does not reverse database migrations or recall external messages. Use the global pause while investigating an automation regression, stop schedulers if necessary, and preserve audit/outbox records for reconciliation.
