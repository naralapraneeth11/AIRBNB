-- Phase 0 foundation (ARCH 03, OPS 01, REC 01, SEC 04).
-- Additive only: safe to apply to any database, including one holding data.
-- These are global operational tables, not tenant data, so they sit outside
-- tenant row-level security like "RateLimit". None stores secrets.

-- One row: the environment this database belongs to. Written only by the
-- schema owner (pnpm db:mark-environment); the runtime role can read it, and
-- the application refuses to serve tenant data when its APP_ENVIRONMENT does
-- not match. This is the interlock that keeps preview and staging deployments
-- away from production data.
CREATE TABLE "DeploymentEnvironment" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "name" TEXT NOT NULL,
    "markedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "markedBy" TEXT NOT NULL,
    CONSTRAINT "DeploymentEnvironment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT deployment_environment_singleton CHECK ("id" = 1),
    CONSTRAINT deployment_environment_name CHECK ("name" IN ('production','staging','development','test'))
);

-- A single scheduler lease so overlapping ticks (Vercel/Cloudflare clock plus a
-- local worker, or a slow tick) never run concurrently. Row seeded below.
CREATE TABLE "SchedulerLease" (
    "id" TEXT NOT NULL,
    "holder" TEXT,
    "leaseUntil" TIMESTAMP(3),
    CONSTRAINT "SchedulerLease_pkey" PRIMARY KEY ("id")
);
INSERT INTO "SchedulerLease" ("id") VALUES ('scheduler');

-- OPS 01: every tick records durable progress, not only that it answered.
CREATE TABLE "SchedulerTick" (
    "id" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "workspaces" INTEGER NOT NULL DEFAULT 0,
    "claimed" INTEGER NOT NULL DEFAULT 0,
    "completed" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "retries" INTEGER NOT NULL DEFAULT 0,
    "dispatched" INTEGER NOT NULL DEFAULT 0,
    "backlog" INTEGER NOT NULL DEFAULT 0,
    "oldestDueAt" TIMESTAMP(3),
    "oldestOutboxDueAt" TIMESTAMP(3),
    "errorCode" TEXT,
    CONSTRAINT "SchedulerTick_pkey" PRIMARY KEY ("id"),
    CONSTRAINT scheduler_tick_trigger CHECK ("trigger" IN ('CRON_HTTP','WORKER')),
    CONSTRAINT scheduler_tick_status CHECK ("status" IN ('RUNNING','COMPLETED','FAILED','SKIPPED_OVERLAP')),
    CONSTRAINT scheduler_tick_counts CHECK ("claimed" >= 0 AND "completed" >= 0 AND "failed" >= 0 AND "retries" >= 0 AND "dispatched" >= 0 AND "backlog" >= 0)
);
CREATE INDEX "SchedulerTick_startedAt_idx" ON "SchedulerTick"("startedAt");
CREATE INDEX "SchedulerTick_status_completedAt_idx" ON "SchedulerTick"("status", "completedAt");

-- REC 01: evidence that each backup path ran and was verified. Recorded by the
-- backup jobs through a least-privilege backup role; read by the operations
-- health endpoint for freshness alerts. "coverage" lists what the artifact
-- covers (for KEYS: key identifiers only, never key material).
CREATE TABLE "BackupRun" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "artifactSha256" TEXT,
    "bytes" BIGINT,
    "objectCount" INTEGER,
    "coverage" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "destination" TEXT,
    "notes" TEXT,
    "recordedBy" TEXT NOT NULL,
    CONSTRAINT "BackupRun_pkey" PRIMARY KEY ("id"),
    CONSTRAINT backup_run_kind CHECK ("kind" IN ('POSTGRES','STORAGE','KEYS')),
    CONSTRAINT backup_run_status CHECK ("status" IN ('SUCCEEDED','FAILED')),
    CONSTRAINT backup_run_verified CHECK ("status" <> 'SUCCEEDED' OR "verifiedAt" IS NOT NULL),
    CONSTRAINT backup_run_digest CHECK ("artifactSha256" IS NULL OR "artifactSha256" ~ '^[0-9a-f]{64}$')
);
CREATE INDEX "BackupRun_kind_status_completedAt_idx" ON "BackupRun"("kind", "status", "completedAt");
