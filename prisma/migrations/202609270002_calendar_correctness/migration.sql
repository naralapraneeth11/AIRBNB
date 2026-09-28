-- Phase 1 calendar correctness data model (DATA 01-03, SEC 01, CLASS 02,
-- EXPORT 01-04, CLEAN 01/03, LIFE 04).
--
-- This is the single reviewed rebuild allowed by the MIG 01 pre-launch
-- exception. It replaces "Booking", "SyncSource" and "SyncRun". It refuses to
-- run while any of those tables holds a row, so it cannot destroy host data:
-- with real data present, the expand/backfill/validate/switch/contract path is
-- mandatory. The product owner's written confirmation and a verified backup are
-- still required before applying it anywhere (docs/RELEASE_GATES.md).
--
-- Tenant tables use FORCE row-level security, which also binds the table owner
-- running this migration. Every statement that reads or writes tenant rows
-- therefore runs once per workspace under a transaction-local tenant scope.

-- ---------------------------------------------------------------------------
-- 1. Guard: no calendar data may exist.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  w record;
  found bigint := 0;
  c bigint;
BEGIN
  FOR w IN SELECT "id" FROM "Workspace" LOOP
    PERFORM set_config('app.workspace_id', w."id", true);
    SELECT count(*) INTO c FROM "Booking";    found := found + c;
    SELECT count(*) INTO c FROM "SyncSource"; found := found + c;
    SELECT count(*) INTO c FROM "SyncRun";    found := found + c;
  END LOOP;
  PERFORM set_config('app.workspace_id', '', true);
  IF found > 0 THEN
    RAISE EXCEPTION 'Calendar rebuild refused: % calendar row(s) exist.', found
      USING HINT = 'This migration is valid only under the MIG 01 pre-launch exception (no real host data). Back up and reset a disposable database, or implement the expand/backfill path.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Detach and drop the legacy calendar tables (verified empty above).
-- ---------------------------------------------------------------------------
ALTER TABLE "CleaningTask" DROP CONSTRAINT "task_booking_fk";
DROP INDEX "CleaningTask_workspaceId_bookingId_key";
ALTER TABLE "Thread" DROP CONSTRAINT "thread_booking_fk";
DROP TABLE "SyncRun";
DROP TABLE "Booking";
DROP TABLE "SyncSource";

-- ---------------------------------------------------------------------------
-- 3. Workspace rollout flag and per-property calendar revision.
-- ---------------------------------------------------------------------------
-- REL 01: new calendar decisions start in SHADOW (no export serving, no push)
-- until an operator switches a workspace to LIVE after the shadow review.
ALTER TABLE "Workspace" ADD COLUMN "calendarMode" TEXT NOT NULL DEFAULT 'SHADOW';
ALTER TABLE "Workspace" ADD CONSTRAINT workspace_calendar_mode CHECK ("calendarMode" IN ('SHADOW','LIVE'));

-- CAL 03 / EXPORT 04: monotonic revision of the property's committed calendar.
ALTER TABLE "Listing" ADD COLUMN "calendarRevision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Listing" ADD CONSTRAINT listing_calendar_revision CHECK ("calendarRevision" >= 0);

-- EXPORT 01: the first property-local date on which a published export changes
-- by the passage of time alone (its oldest event leaves the history window),
-- so exports are republished exactly then rather than recomputed every tick.
ALTER TABLE "Listing" ADD COLUMN "exportRefreshOn" DATE;

-- ---------------------------------------------------------------------------
-- 4. Channel connections (replaces SyncSource and the listing master token).
-- ---------------------------------------------------------------------------
CREATE TABLE "ChannelConnection" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "label" TEXT,
    "importUrlEncrypted" TEXT,
    "importUrlDigest" TEXT,
    "exportTokenHash" TEXT NOT NULL,
    "exportTokenGeneration" INTEGER NOT NULL DEFAULT 1,
    "capabilitiesVersion" TEXT NOT NULL,
    "policyMode" TEXT NOT NULL DEFAULT 'UNSET',
    "policyLabels" JSONB,
    "policyVersion" INTEGER NOT NULL DEFAULT 0,
    "policyDecidedBy" TEXT,
    "policyDecidedAt" TIMESTAMP(3),
    "policyEvidenceEncrypted" TEXT,
    "health" TEXT NOT NULL DEFAULT 'PENDING',
    "lastResult" TEXT,
    "lastObservationId" TEXT,
    "lastSuccessAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "lastAcceptedAt" TIMESTAMP(3),
    "lastAcceptedFingerprint" TEXT,
    "lastAcceptedComplete" BOOLEAN NOT NULL DEFAULT false,
    "coverageEnd" DATE,
    "nearTerm" BOOLEAN NOT NULL DEFAULT false,
    "nextFetchAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceRetryAfter" TIMESTAMP(3),
    "failures" INTEGER NOT NULL DEFAULT 0,
    "etag" TEXT,
    "lastModified" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "leaseToken" TEXT,
    "fence" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ChannelConnection_pkey" PRIMARY KEY ("id"),
    CONSTRAINT connection_platform CHECK ("platform" IN ('AIRBNB','VRBO','BOOKING','EXPEDIA','GOOGLE','OTHER')),
    CONSTRAINT connection_policy_mode CHECK ("policyMode" IN ('UNSET','RESERVATIONS','OWNER_BLOCKS','BY_LABEL')),
    CONSTRAINT connection_policy_labels CHECK ("policyMode" <> 'BY_LABEL' OR "policyLabels" IS NOT NULL),
    CONSTRAINT connection_policy_decided CHECK ("policyMode" = 'UNSET' OR ("policyDecidedBy" IS NOT NULL AND "policyDecidedAt" IS NOT NULL)),
    CONSTRAINT connection_health CHECK ("health" IN ('PENDING','HEALTHY','DEGRADED','FAILING','PAUSED_BY_SOURCE','EXPORT_ONLY','DISABLED')),
    CONSTRAINT connection_last_result CHECK ("lastResult" IS NULL OR "lastResult" IN ('NO_CHANGES','UPDATED','NEEDS_REVIEW','COULD_NOT_CHECK')),
    CONSTRAINT connection_import_pair CHECK (("importUrlEncrypted" IS NULL) = ("importUrlDigest" IS NULL)),
    CONSTRAINT connection_counters CHECK ("exportTokenGeneration" >= 1 AND "fence" >= 0 AND "failures" >= 0 AND "policyVersion" >= 0),
    CONSTRAINT connection_lease_pair CHECK (("leaseToken" IS NULL) = ("leaseUntil" IS NULL))
);
CREATE UNIQUE INDEX "ChannelConnection_exportTokenHash_key" ON "ChannelConnection"("exportTokenHash");
CREATE UNIQUE INDEX "ChannelConnection_workspaceId_id_key" ON "ChannelConnection"("workspaceId", "id");
CREATE UNIQUE INDEX "ChannelConnection_workspaceId_listingId_id_key" ON "ChannelConnection"("workspaceId", "listingId", "id");
CREATE INDEX "ChannelConnection_workspaceId_nextFetchAt_idx" ON "ChannelConnection"("workspaceId", "nextFetchAt");
-- DATA 02: several accounts on one platform are valid, so uniqueness is by
-- the secret feed itself (keyed digest), never by property plus platform.
CREATE UNIQUE INDEX connection_import_feed_unique ON "ChannelConnection"("workspaceId", "importUrlDigest") WHERE "importUrlDigest" IS NOT NULL AND "enabled";
ALTER TABLE "ChannelConnection" ADD CONSTRAINT connection_listing_fk FOREIGN KEY ("workspaceId","listingId") REFERENCES "Listing"("workspaceId","id");

-- Preserve every existing master export link (MIG 01: token links) as an
-- export-only connection carrying the same token hash, then retire the column.
DO $$
DECLARE w record;
BEGIN
  FOR w IN SELECT "id" FROM "Workspace" LOOP
    PERFORM set_config('app.workspace_id', w."id", true);
    INSERT INTO "ChannelConnection" ("id","workspaceId","listingId","platform","label","exportTokenHash","capabilitiesVersion","health","updatedAt")
    SELECT gen_random_uuid()::text, l."workspaceId", l."id", 'OTHER', 'All-channel export link', l."exportTokenHash", '2026-09-27.1', 'EXPORT_ONLY', CURRENT_TIMESTAMP
    FROM "Listing" l;
  END LOOP;
  PERFORM set_config('app.workspace_id', '', true);
END $$;
DROP INDEX "Listing_exportTokenHash_key";
ALTER TABLE "Listing" DROP COLUMN "exportTokenHash";

-- ---------------------------------------------------------------------------
-- 5. Feed observations (replaces SyncRun). One row per fetch attempt.
-- ---------------------------------------------------------------------------
CREATE TABLE "FeedObservation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "fence" INTEGER NOT NULL,
    "httpStatus" INTEGER,
    "outcome" TEXT NOT NULL,
    "failureCode" TEXT,
    "complete" BOOLEAN NOT NULL,
    "health" TEXT NOT NULL,
    "allowedOps" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reasonCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "fingerprint" TEXT,
    "coverageStart" DATE,
    "coverageEnd" DATE,
    "counts" JSONB NOT NULL,
    "decisions" JSONB,
    "rulesVersion" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "recomputed" BOOLEAN NOT NULL DEFAULT false,
    "accepted" BOOLEAN NOT NULL DEFAULT false,
    "snapshotEncrypted" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FeedObservation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT observation_trigger CHECK ("trigger" IN ('SCHEDULED','MANUAL')),
    CONSTRAINT observation_mode CHECK ("mode" IN ('SHADOW','LIVE')),
    CONSTRAINT observation_outcome CHECK ("outcome" IN ('BODY','NOT_MODIFIED','FAILED')),
    CONSTRAINT observation_health CHECK ("health" IN ('HEALTHY','PARTIAL','EMPTY_ANOMALY','DROP_ANOMALY','FAILED')),
    CONSTRAINT observation_result CHECK ("result" IN ('NO_CHANGES','UPDATED','NEEDS_REVIEW','COULD_NOT_CHECK')),
    CONSTRAINT observation_failure CHECK (("outcome" = 'FAILED') = ("failureCode" IS NOT NULL)),
    CONSTRAINT observation_snapshot CHECK ("snapshotEncrypted" IS NULL OR "accepted"),
    CONSTRAINT observation_duration CHECK ("durationMs" >= 0)
);
CREATE UNIQUE INDEX "FeedObservation_workspaceId_id_key" ON "FeedObservation"("workspaceId", "id");
CREATE INDEX "FeedObservation_workspaceId_connectionId_observedAt_idx" ON "FeedObservation"("workspaceId", "connectionId", "observedAt");
CREATE INDEX "FeedObservation_workspaceId_observedAt_idx" ON "FeedObservation"("workspaceId", "observedAt");
ALTER TABLE "FeedObservation" ADD CONSTRAINT observation_connection_fk FOREIGN KEY ("workspaceId","connectionId") REFERENCES "ChannelConnection"("workspaceId","id");

-- ---------------------------------------------------------------------------
-- 6. Availability blocks: the protective unit of the calendar.
-- ---------------------------------------------------------------------------
CREATE TABLE "AvailabilityBlock" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "connectionId" TEXT,
    "sourceKey" TEXT,
    "identityKind" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "classification" TEXT NOT NULL,
    "classificationEvidence" JSONB NOT NULL,
    "holdType" TEXT,
    "reasonEncrypted" TEXT,
    "lifecycle" TEXT NOT NULL,
    "decisionReason" TEXT,
    "sourceStatus" TEXT NOT NULL,
    "sourceSequence" INTEGER,
    "sourceStamp" TIMESTAMP(3),
    "sourceLabelKey" TEXT,
    "contentDigest" TEXT,
    "sourceRevision" INTEGER NOT NULL DEFAULT 0,
    "firstSeenAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "missingSince" TIMESTAMP(3),
    "missingObservations" INTEGER NOT NULL DEFAULT 0,
    "lastMissingObservationAt" TIMESTAMP(3),
    "bufferBeforeDays" INTEGER,
    "bufferAfterDays" INTEGER,
    "overrideClassification" TEXT,
    "overrideBasedOnRevision" INTEGER,
    "overrideBy" TEXT,
    "overrideAt" TIMESTAMP(3),
    "reviewFlags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pendingChange" JSONB,
    "compensatesBlockId" TEXT,
    "clientRequestId" TEXT,
    "createdBy" TEXT,
    "releasedAt" TIMESTAMP(3),
    "releasedBy" TEXT,
    "releaseReasonEncrypted" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "committedRevision" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AvailabilityBlock_pkey" PRIMARY KEY ("id"),
    -- DATE 01: the end date is exclusive, so a stay protects at least one night.
    CONSTRAINT block_dates CHECK ("endDate" > "startDate"),
    CONSTRAINT block_identity_kind CHECK ("identityKind" IN ('UID','RECURRENCE_INSTANCE','SURROGATE','DUPLICATE_VARIANT','MANUAL')),
    CONSTRAINT block_classification CHECK ("classification" IN ('RESERVATION','OWNER_BLOCK','UNKNOWN','CONFIRMED_ECHO','MANUAL')),
    CONSTRAINT block_lifecycle CHECK ("lifecycle" IN ('ACTIVE','MISSING_OBSERVED','AWAITING_DECISION','RETAINED_HOLD','RELEASED')),
    CONSTRAINT block_source_status CHECK ("sourceStatus" IN ('CONFIRMED','TENTATIVE','CANCELLED')),
    CONSTRAINT block_manual_shape CHECK (
      ("connectionId" IS NULL) = ("identityKind" = 'MANUAL')
      AND ("connectionId" IS NULL) = ("sourceKey" IS NULL)
      AND ("identityKind" = 'MANUAL') = ("holdType" IS NOT NULL)),
    CONSTRAINT block_hold_type CHECK ("holdType" IS NULL OR "holdType" IN ('OWNER','MAINTENANCE','DIRECT_RESERVATION','RESTORED')),
    CONSTRAINT block_manual_classification CHECK (
      ("identityKind" = 'MANUAL' AND "classification" IN ('MANUAL','RESERVATION'))
      OR ("identityKind" <> 'MANUAL' AND "classification" <> 'MANUAL')),
    -- ID 02: an event without reliable identity is never classified.
    CONSTRAINT block_surrogate_unknown CHECK ("identityKind" NOT IN ('SURROGATE','DUPLICATE_VARIANT') OR "classification" = 'UNKNOWN'),
    CONSTRAINT block_released CHECK (("lifecycle" = 'RELEASED') = ("releasedAt" IS NOT NULL)),
    CONSTRAINT block_decision_reason CHECK (
      ("lifecycle" = 'AWAITING_DECISION') = ("decisionReason" IS NOT NULL)
      AND ("decisionReason" IS NULL OR "decisionReason" IN ('ABSENCE','CANCELLATION'))),
    CONSTRAINT block_missing CHECK ("missingObservations" >= 0 AND ("lifecycle" <> 'MISSING_OBSERVED' OR "missingSince" IS NOT NULL)),
    CONSTRAINT block_buffers CHECK (("bufferBeforeDays" IS NULL OR "bufferBeforeDays" BETWEEN 0 AND 14) AND ("bufferAfterDays" IS NULL OR "bufferAfterDays" BETWEEN 0 AND 14)),
    CONSTRAINT block_override CHECK (
      ("overrideClassification" IS NULL OR "overrideClassification" IN ('RESERVATION','OWNER_BLOCK','UNKNOWN'))
      AND ("overrideClassification" IS NULL OR "identityKind" IN ('UID','RECURRENCE_INSTANCE'))),
    CONSTRAINT block_revisions CHECK ("revision" >= 0 AND "committedRevision" >= 0 AND "sourceRevision" >= 0)
);
CREATE UNIQUE INDEX "AvailabilityBlock_workspaceId_id_key" ON "AvailabilityBlock"("workspaceId", "id");
CREATE UNIQUE INDEX "AvailabilityBlock_workspaceId_listingId_id_key" ON "AvailabilityBlock"("workspaceId", "listingId", "id");
-- DATA 02 / ID 01: identity is scoped to its source connection.
CREATE UNIQUE INDEX "AvailabilityBlock_workspaceId_connectionId_sourceKey_key" ON "AvailabilityBlock"("workspaceId", "connectionId", "sourceKey");
CREATE UNIQUE INDEX "AvailabilityBlock_workspaceId_clientRequestId_key" ON "AvailabilityBlock"("workspaceId", "clientRequestId");
-- DATA 01: overlaps are recorded as conflicts, never rejected by an exclusion
-- constraint. This index serves the overlap lookup within a property.
CREATE INDEX "AvailabilityBlock_workspaceId_listingId_startDate_endDate_idx" ON "AvailabilityBlock"("workspaceId", "listingId", "startDate", "endDate");
CREATE INDEX "AvailabilityBlock_workspaceId_lifecycle_idx" ON "AvailabilityBlock"("workspaceId", "lifecycle");
ALTER TABLE "AvailabilityBlock" ADD CONSTRAINT block_listing_fk FOREIGN KEY ("workspaceId","listingId") REFERENCES "Listing"("workspaceId","id");
ALTER TABLE "AvailabilityBlock" ADD CONSTRAINT block_connection_fk FOREIGN KEY ("workspaceId","listingId","connectionId") REFERENCES "ChannelConnection"("workspaceId","listingId","id");
ALTER TABLE "AvailabilityBlock" ADD CONSTRAINT block_compensates_fk FOREIGN KEY ("workspaceId","listingId","compensatesBlockId") REFERENCES "AvailabilityBlock"("workspaceId","listingId","id");

-- ---------------------------------------------------------------------------
-- 7. Reservations: stay information, separate from generic availability.
-- ---------------------------------------------------------------------------
CREATE TABLE "Reservation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "blockId" TEXT,
    "source" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "sourceReservationKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'CONFIRMED',
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "guestNameEncrypted" TEXT,
    "guestContactEncrypted" TEXT,
    "guestHash" TEXT,
    "price" DECIMAL(12,2),
    "currency" TEXT NOT NULL,
    "sourceCreatedAt" TIMESTAMP(3),
    "firstObservedAt" TIMESTAMP(3) NOT NULL,
    "clientRequestId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Reservation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT reservation_dates CHECK ("endDate" > "startDate"),
    CONSTRAINT reservation_price CHECK ("price" IS NULL OR "price" >= 0),
    CONSTRAINT reservation_source CHECK ("source" IN ('IMPORTED','DIRECT')),
    CONSTRAINT reservation_platform CHECK ("platform" IN ('AIRBNB','VRBO','BOOKING','EXPEDIA','GOOGLE','OTHER','DIRECT')),
    CONSTRAINT reservation_direct_platform CHECK (("source" = 'DIRECT') = ("platform" = 'DIRECT')),
    CONSTRAINT reservation_status CHECK ("status" IN ('CONFIRMED','CANCELLED','RECLASSIFIED')),
    CONSTRAINT reservation_imported_key CHECK ("source" <> 'IMPORTED' OR "sourceReservationKey" IS NOT NULL)
);
CREATE UNIQUE INDEX "Reservation_workspaceId_id_key" ON "Reservation"("workspaceId", "id");
CREATE UNIQUE INDEX "Reservation_workspaceId_listingId_id_key" ON "Reservation"("workspaceId", "listingId", "id");
CREATE UNIQUE INDEX "Reservation_workspaceId_blockId_key" ON "Reservation"("workspaceId", "blockId");
CREATE UNIQUE INDEX "Reservation_workspaceId_clientRequestId_key" ON "Reservation"("workspaceId", "clientRequestId");
CREATE INDEX "Reservation_workspaceId_listingId_startDate_endDate_idx" ON "Reservation"("workspaceId", "listingId", "startDate", "endDate");
CREATE INDEX "Reservation_workspaceId_status_idx" ON "Reservation"("workspaceId", "status");
ALTER TABLE "Reservation" ADD CONSTRAINT reservation_listing_fk FOREIGN KEY ("workspaceId","listingId") REFERENCES "Listing"("workspaceId","id");
ALTER TABLE "Reservation" ADD CONSTRAINT reservation_block_fk FOREIGN KEY ("workspaceId","listingId","blockId") REFERENCES "AvailabilityBlock"("workspaceId","listingId","id");

-- ---------------------------------------------------------------------------
-- 8. Conflict cases: one open case per canonically ordered block pair.
-- ---------------------------------------------------------------------------
CREATE TABLE "ConflictCase" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "blockAId" TEXT NOT NULL,
    "blockBId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'OPEN',
    "overlapStart" DATE NOT NULL,
    "overlapEnd" DATE NOT NULL,
    "firstDetectedAt" TIMESTAMP(3) NOT NULL,
    "lastDetectedAt" TIMESTAMP(3) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "resolution" TEXT,
    "resolutionNoteEncrypted" TEXT,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ConflictCase_pkey" PRIMARY KEY ("id"),
    -- Byte order, matching the application's comparison under any database
    -- default collation.
    CONSTRAINT conflict_canonical_pair CHECK ("blockAId" COLLATE "C" < "blockBId" COLLATE "C"),
    CONSTRAINT conflict_kind CHECK ("kind" IN ('RESERVATION_RESERVATION','RESERVATION_HOLD','UNCERTAIN_OVERLAP','BUFFER_ONLY')),
    CONSTRAINT conflict_severity CHECK ("severity" IN ('HIGH','MEDIUM','LOW')),
    CONSTRAINT conflict_state CHECK ("state" IN ('OPEN','RESOLVED')),
    CONSTRAINT conflict_resolution CHECK (
      ("state" = 'RESOLVED') = ("resolvedAt" IS NOT NULL)
      AND ("state" = 'RESOLVED') = ("resolution" IS NOT NULL)
      AND ("resolution" IS NULL OR "resolution" IN ('NO_LONGER_OVERLAPPING','HOST_RECORDED'))),
    CONSTRAINT conflict_overlap CHECK ("overlapEnd" > "overlapStart")
);
CREATE UNIQUE INDEX "ConflictCase_workspaceId_id_key" ON "ConflictCase"("workspaceId", "id");
CREATE INDEX "ConflictCase_workspaceId_listingId_state_idx" ON "ConflictCase"("workspaceId", "listingId", "state");
CREATE UNIQUE INDEX conflict_one_open_case ON "ConflictCase"("workspaceId", "blockAId", "blockBId") WHERE "state" = 'OPEN';
ALTER TABLE "ConflictCase" ADD CONSTRAINT conflict_listing_fk FOREIGN KEY ("workspaceId","listingId") REFERENCES "Listing"("workspaceId","id");
ALTER TABLE "ConflictCase" ADD CONSTRAINT conflict_block_a_fk FOREIGN KEY ("workspaceId","listingId","blockAId") REFERENCES "AvailabilityBlock"("workspaceId","listingId","id");
ALTER TABLE "ConflictCase" ADD CONSTRAINT conflict_block_b_fk FOREIGN KEY ("workspaceId","listingId","blockBId") REFERENCES "AvailabilityBlock"("workspaceId","listingId","id");

-- ---------------------------------------------------------------------------
-- 9. Export versions, retrieval evidence and revoked tokens.
-- ---------------------------------------------------------------------------
CREATE TABLE "ExportVersion" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "bodyDigest" TEXT NOT NULL,
    "body" TEXT,
    "sourceRevision" INTEGER NOT NULL,
    "eventCount" INTEGER NOT NULL,
    "coverageStart" DATE,
    "coverageEnd" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExportVersion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT export_version_positive CHECK ("version" > 0 AND "sourceRevision" >= 0 AND "eventCount" >= 0),
    CONSTRAINT export_version_digest CHECK ("bodyDigest" ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX "ExportVersion_workspaceId_id_key" ON "ExportVersion"("workspaceId", "id");
CREATE UNIQUE INDEX "ExportVersion_workspaceId_connectionId_version_key" ON "ExportVersion"("workspaceId", "connectionId", "version");
ALTER TABLE "ExportVersion" ADD CONSTRAINT export_version_connection_fk FOREIGN KEY ("workspaceId","connectionId") REFERENCES "ChannelConnection"("workspaceId","id");

-- EXPORT 02: request evidence, bucketed hourly per class so telemetry stays
-- bounded while the first retrieval of every new version is preserved.
CREATE TABLE "ExportRetrieval" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "tokenGeneration" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "responseClass" TEXT NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "firstAt" TIMESTAMP(3) NOT NULL,
    "lastAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ExportRetrieval_pkey" PRIMARY KEY ("id"),
    CONSTRAINT retrieval_class CHECK ("responseClass" IN ('BODY','NOT_MODIFIED','HEAD','REVOKED_TOKEN','UNAVAILABLE')),
    CONSTRAINT retrieval_count CHECK ("count" >= 1 AND "version" >= 0 AND "tokenGeneration" >= 1 AND "lastAt" >= "firstAt")
);
CREATE UNIQUE INDEX "ExportRetrieval_bucket_key" ON "ExportRetrieval"("workspaceId", "connectionId", "tokenGeneration", "version", "responseClass", "bucketStart");
CREATE INDEX "ExportRetrieval_workspaceId_connectionId_lastAt_idx" ON "ExportRetrieval"("workspaceId", "connectionId", "lastAt");
ALTER TABLE "ExportRetrieval" ADD CONSTRAINT retrieval_connection_fk FOREIGN KEY ("workspaceId","connectionId") REFERENCES "ChannelConnection"("workspaceId","id");

-- EXPORT 03: hashes of rotated tokens, kept to detect stale links.
CREATE TABLE "RevokedExportToken" (
    "tokenHash" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "revokedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3),
    "hits" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "RevokedExportToken_pkey" PRIMARY KEY ("tokenHash"),
    CONSTRAINT revoked_token_window CHECK ("expiresAt" > "revokedAt" AND "hits" >= 0 AND "generation" >= 1)
);
CREATE INDEX "RevokedExportToken_workspaceId_expiresAt_idx" ON "RevokedExportToken"("workspaceId", "expiresAt");
ALTER TABLE "RevokedExportToken" ADD CONSTRAINT revoked_token_connection_fk FOREIGN KEY ("workspaceId","connectionId") REFERENCES "ChannelConnection"("workspaceId","id");

-- ---------------------------------------------------------------------------
-- 10. Cleaning tasks relink to reservations with cancel/supersede states.
-- ---------------------------------------------------------------------------
ALTER TABLE "CleaningTask" RENAME COLUMN "bookingId" TO "reservationId";
-- MANUAL by default: a TURNOVER task is created only by the turnover planner,
-- explicitly and always with its reservation (CLEAN 01).
ALTER TABLE "CleaningTask" ADD COLUMN "taskType" TEXT NOT NULL DEFAULT 'MANUAL';
ALTER TABLE "CleaningTask" ADD COLUMN "departureDate" DATE;
ALTER TABLE "CleaningTask" ADD COLUMN "supersedesTaskId" TEXT;
ALTER TABLE "CleaningTask" ADD COLUMN "reviewRequired" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CleaningTask" ADD COLUMN "reviewReason" TEXT;
ALTER TABLE "CleaningTask" ADD COLUMN "closedAt" TIMESTAMP(3);
ALTER TABLE "CleaningTask" ADD COLUMN "closeReason" TEXT;
-- Existing rows can only be host-created manual tasks (no reservations
-- exist), which the MANUAL default already describes.
ALTER TABLE "CleaningTask" DROP CONSTRAINT "task_status";
ALTER TABLE "CleaningTask" ADD CONSTRAINT task_status CHECK ("status" IN ('NEEDS_SCHEDULING','ASSIGNED','ACCEPTED','IN_PROGRESS','DONE','VERIFIED','CANCELLED','SUPERSEDED'));
ALTER TABLE "CleaningTask" ADD CONSTRAINT task_type CHECK ("taskType" IN ('TURNOVER','MANUAL'));
ALTER TABLE "CleaningTask" ADD CONSTRAINT task_turnover_shape CHECK (("taskType" = 'TURNOVER') = ("reservationId" IS NOT NULL) AND ("reservationId" IS NULL OR "departureDate" IS NOT NULL));
ALTER TABLE "CleaningTask" ADD CONSTRAINT task_closed CHECK (("status" IN ('CANCELLED','SUPERSEDED')) = ("closedAt" IS NOT NULL) AND ("closedAt" IS NULL OR "closeReason" IS NOT NULL));
ALTER TABLE "CleaningTask" ADD CONSTRAINT task_review CHECK (NOT "reviewRequired" OR "reviewReason" IS NOT NULL);
CREATE UNIQUE INDEX "CleaningTask_workspaceId_listingId_id_key" ON "CleaningTask"("workspaceId", "listingId", "id");
-- CLEAN 01: one effective task per stay departure and task type.
CREATE UNIQUE INDEX task_one_effective_turnover ON "CleaningTask"("workspaceId", "reservationId", "taskType", "departureDate") WHERE "reservationId" IS NOT NULL AND "status" NOT IN ('CANCELLED','SUPERSEDED');
CREATE INDEX "CleaningTask_workspaceId_reservationId_idx" ON "CleaningTask"("workspaceId", "reservationId");
ALTER TABLE "CleaningTask" ADD CONSTRAINT task_reservation_fk FOREIGN KEY ("workspaceId","listingId","reservationId") REFERENCES "Reservation"("workspaceId","listingId","id");
ALTER TABLE "CleaningTask" ADD CONSTRAINT task_supersedes_fk FOREIGN KEY ("workspaceId","supersedesTaskId") REFERENCES "CleaningTask"("workspaceId","id");

-- ---------------------------------------------------------------------------
-- 11. Conversations relink to reservations (thread and stay on one property).
-- ---------------------------------------------------------------------------
ALTER TABLE "Thread" RENAME COLUMN "bookingId" TO "reservationId";
ALTER TABLE "Thread" ADD CONSTRAINT thread_reservation_fk FOREIGN KEY ("workspaceId","listingId","reservationId") REFERENCES "Reservation"("workspaceId","listingId","id");

-- ---------------------------------------------------------------------------
-- 12. Tenant isolation for every new table (SEC 01).
-- ---------------------------------------------------------------------------
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['ChannelConnection','FeedObservation','AvailabilityBlock','Reservation','ConflictCase','ExportVersion','ExportRetrieval','RevokedExportToken'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_scope ON %I USING ("workspaceId" = nullif(current_setting(''app.workspace_id'',true),'''')) WITH CHECK ("workspaceId" = nullif(current_setting(''app.workspace_id'',true),''''))',t);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT',t,t||'_workspace_fk');
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 13. LIFE 04: routine reconciliation never hard-deletes operational history.
-- Only the schema owner (a privileged, audited erasure or retention job under
-- PRIV 02) may delete; the runtime role cannot.
-- ---------------------------------------------------------------------------
CREATE FUNCTION prevent_routine_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = TG_RELID) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% rows are never hard-deleted by routine operations (LIFE 04)', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER no_routine_delete BEFORE DELETE ON "AvailabilityBlock" FOR EACH ROW EXECUTE FUNCTION prevent_routine_delete();
CREATE TRIGGER no_routine_delete BEFORE DELETE ON "Reservation" FOR EACH ROW EXECUTE FUNCTION prevent_routine_delete();
CREATE TRIGGER no_routine_delete BEFORE DELETE ON "ConflictCase" FOR EACH ROW EXECUTE FUNCTION prevent_routine_delete();
CREATE TRIGGER no_routine_delete BEFORE DELETE ON "ExportVersion" FOR EACH ROW EXECUTE FUNCTION prevent_routine_delete();
CREATE TRIGGER no_routine_delete BEFORE DELETE ON "CleaningTask" FOR EACH ROW EXECUTE FUNCTION prevent_routine_delete();
