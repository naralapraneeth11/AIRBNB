-- Least-privilege grants for the application's runtime role (SEC 01).
-- Run as the schema owner after `pnpm db:migrate`, with psql:
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -v runtime_role=airbnb_app \
--        -f prisma/grants/runtime-role.sql
--
-- Create the role first as an administrator (see docs/DEPLOYMENT.md):
--   CREATE ROLE airbnb_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
--     NOINHERIT NOREPLICATION NOBYPASSRLS;
--
-- The script is idempotent. It revokes before granting so a re-run also
-- removes privileges from tables that no longer exist or changed class.
-- Tenant tables keep FORCE row-level security: these grants never widen
-- what a transaction without `app.workspace_id` can see.

\set ON_ERROR_STOP on

GRANT USAGE ON SCHEMA public TO :"runtime_role";
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM :"runtime_role";

-- Identity, sessions and tenant data the application reads and writes.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  "Workspace", "User", "Membership", "Session", "RateLimit",
  "Listing", "Cleaner", "MagicLink", "Asset", "Thread", "Message",
  "AutomationSettings", "AutomationRule", "Outbox", "Notification",
  "PushSubscription", "Integration", "ChannelConnection"
TO :"runtime_role";

-- Calendar and cleaning history is never hard-deleted by routine work
-- (LIFE 04); triggers enforce this too, but the grant does not offer it.
GRANT SELECT, INSERT, UPDATE ON TABLE
  "AvailabilityBlock", "Reservation", "ConflictCase", "ExportVersion",
  "CleaningTask"
TO :"runtime_role";

-- Bounded operational evidence with retention (DATA 03, EXPORT 02/03).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  "FeedObservation", "ExportRetrieval", "RevokedExportToken"
TO :"runtime_role";

-- Append-only history.
GRANT SELECT, INSERT ON TABLE "AuditLog", "DomainEvent" TO :"runtime_role";

-- Permanent deletion of a removed property (PRIV 02) goes through one
-- database function, which checks the workspace and that the property was
-- removed, and writes the ledger itself. The application may read the
-- ledger and mark stored photos deleted, nothing more.
REVOKE ALL ON FUNCTION erase_listing(TEXT, TEXT, TEXT) FROM :"runtime_role";
GRANT EXECUTE ON FUNCTION erase_listing(TEXT, TEXT, TEXT) TO :"runtime_role";
GRANT SELECT ON TABLE "Erasure" TO :"runtime_role";
GRANT UPDATE ("pendingObjects") ON TABLE "Erasure" TO :"runtime_role";

-- Scheduler coordination and tick records (ARCH 03, OPS 01).
GRANT SELECT, UPDATE ON TABLE "SchedulerLease" TO :"runtime_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "SchedulerTick" TO :"runtime_role";

-- Self-service accounts (AUTH 01, AUTH 03): pending sign-ups and reset
-- links are deleted once used or expired; setup progress is tenant data.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  "PendingRegistration", "PasswordReset"
TO :"runtime_role";
GRANT SELECT, INSERT, UPDATE ON TABLE "OnboardingProgress" TO :"runtime_role";

-- Read-only: the environment marker is written by the schema owner
-- (pnpm db:mark-environment) and backup evidence by the backup role.
GRANT SELECT ON TABLE "DeploymentEnvironment", "BackupRun" TO :"runtime_role";

-- Never: _prisma_migrations, ownership, schema creation, or default
-- privileges on future tables. Review each new table's tenant policy and
-- grant only what the next release needs.
REVOKE CREATE ON SCHEMA public FROM :"runtime_role";
