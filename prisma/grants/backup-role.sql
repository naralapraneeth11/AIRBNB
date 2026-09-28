-- REC 01: a separate, read-only role for the nightly backup jobs.
-- Run as an administrator (creating a BYPASSRLS role needs one), with psql:
--
--   psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -v backup_role=hostsphere_backup \
--        -v database=airbnb -f prisma/grants/backup-role.sql
--
-- then set the role's password through your provider's secret interface.
--
-- pg_dump must read every tenant's rows, and FORCE row-level security binds
-- every other role, so this role bypasses RLS. In exchange it can write
-- nothing except its own evidence rows in "BackupRun". Keep its credentials
-- only in the backup job's protected environment, never in the application.

\set ON_ERROR_STOP on

SELECT format(
  'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION BYPASSRLS',
  :'backup_role')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'backup_role') \gexec

ALTER ROLE :"backup_role" NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION BYPASSRLS;
GRANT CONNECT ON DATABASE :"database" TO :"backup_role";
GRANT USAGE ON SCHEMA public TO :"backup_role";
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM :"backup_role";
GRANT SELECT ON ALL TABLES IN SCHEMA public TO :"backup_role";
GRANT INSERT ON TABLE "BackupRun" TO :"backup_role";
REVOKE CREATE ON SCHEMA public FROM :"backup_role";
