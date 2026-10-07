-- Permanent deletion of a removed property (PRIV 02). Routine work never
-- deletes calendar or cleaning history (LIFE 04); this adds the one
-- privileged path that may, with its own checks, and a ledger that records
-- that a deletion happened without keeping what was deleted. The audit log
-- and domain events are not touched: they stay append-only, as before.
--
-- Additive: a new table and a new function that the previous release never
-- calls, so this is safe to run before or after it is replaced (MIG 01
-- expand step). Re-run prisma/grants/runtime-role.sql afterwards: it grants
-- EXECUTE on the function and access to the ledger.

-- ---------------------------------------------------------------------------
-- The ledger: which property was deleted, when, why and by whom, with
-- counts. No names, addresses, dates or guest details. Stored photos that
-- still have to be deleted are listed until they are gone. Tenant-scoped like
-- everything else; the runtime role may read it and update only
-- "pendingObjects".
-- ---------------------------------------------------------------------------
CREATE TABLE "Erasure" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "counts" JSONB NOT NULL,
    "pendingObjects" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "erasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Erasure_pkey" PRIMARY KEY ("id"),
    CONSTRAINT erasure_workspace_fk FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT,
    CONSTRAINT erasure_subject CHECK ("subject" IN ('LISTING')),
    CONSTRAINT erasure_trigger CHECK ("trigger" IN ('OWNER','RETENTION','REAPPLIED'))
);
CREATE UNIQUE INDEX "Erasure_workspaceId_subject_subjectId_key" ON "Erasure"("workspaceId", "subject", "subjectId");
CREATE INDEX "Erasure_workspaceId_erasedAt_idx" ON "Erasure"("workspaceId", "erasedAt");
ALTER TABLE "Erasure" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Erasure" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON "Erasure"
  USING ("workspaceId" = nullif(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspaceId" = nullif(current_setting('app.workspace_id', true), ''));

-- ---------------------------------------------------------------------------
-- erase_listing: delete everything stored for one removed property in the
-- caller's workspace, in one transaction, and record it in the ledger.
--
-- It runs as the schema owner (SECURITY DEFINER), whom the history triggers
-- allow to delete. It acts only inside the workspace the caller's
-- transaction is scoped to (every statement names it, on top of row-level
-- security), only on a property already removed from the app, and only on
-- rows found through their link to that property. The runtime role still
-- cannot delete history by any other route.
--
-- Rows are locked as they are found, so work that arrives meanwhile (a guest
-- message for one of its stays, a cleaner's update) waits and then fails
-- instead of leaving something behind. A message or notice being handed to a
-- provider at this moment cannot be recalled, so the deletion refuses and
-- can be tried again once it is done.
-- ---------------------------------------------------------------------------
CREATE FUNCTION erase_listing(p_listing_id TEXT, p_trigger TEXT, p_actor TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  ws TEXT := nullif(current_setting('app.workspace_id', true), '');
  removed_at TIMESTAMP(3);
  erasure_id TEXT := gen_random_uuid()::TEXT;
  connections TEXT[];
  blocks TEXT[];
  reservations TEXT[];
  conflicts TEXT[];
  tasks TEXT[];
  threads TEXT[];
  messages TEXT[];
  assets TEXT[];
  objects TEXT[];
  owned TEXT[];
  jobs TEXT[];
  notifications TEXT[];
  observations INT;
  versions INT;
  counts JSONB;
BEGIN
  IF ws IS NULL THEN
    RAISE EXCEPTION 'erase_listing runs only inside a workspace scope'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_trigger IS NULL OR p_trigger NOT IN ('OWNER', 'RETENTION', 'REAPPLIED') THEN
    RAISE EXCEPTION 'Unknown erasure trigger' USING ERRCODE = 'check_violation';
  END IF;
  IF coalesce(p_actor, '') = '' THEN
    RAISE EXCEPTION 'An erasure needs an actor' USING ERRCODE = 'check_violation';
  END IF;
  SELECT "archivedAt" INTO removed_at FROM "Listing"
    WHERE "id" = p_listing_id AND "workspaceId" = ws FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Property not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF removed_at IS NULL THEN
    RAISE EXCEPTION 'Only a property removed from the app can be deleted'
      USING ERRCODE = 'object_in_use';
  END IF;

  -- Everything that belongs to the property, found through its own links.
  SELECT coalesce(array_agg("id"), '{}') INTO connections FROM (
    SELECT "id" FROM "ChannelConnection"
     WHERE "workspaceId" = ws AND "listingId" = p_listing_id FOR UPDATE) r;
  SELECT coalesce(array_agg("id"), '{}') INTO blocks FROM (
    SELECT "id" FROM "AvailabilityBlock"
     WHERE "workspaceId" = ws AND "listingId" = p_listing_id FOR UPDATE) r;
  SELECT coalesce(array_agg("id"), '{}') INTO reservations FROM (
    SELECT "id" FROM "Reservation"
     WHERE "workspaceId" = ws AND "listingId" = p_listing_id FOR UPDATE) r;
  SELECT coalesce(array_agg("id"), '{}') INTO conflicts FROM (
    SELECT "id" FROM "ConflictCase"
     WHERE "workspaceId" = ws AND "listingId" = p_listing_id FOR UPDATE) r;
  SELECT coalesce(array_agg("id"), '{}') INTO tasks FROM (
    SELECT "id" FROM "CleaningTask"
     WHERE "workspaceId" = ws AND "listingId" = p_listing_id FOR UPDATE) r;
  SELECT coalesce(array_agg("id"), '{}') INTO threads FROM (
    SELECT "id" FROM "Thread"
     WHERE "workspaceId" = ws AND "listingId" = p_listing_id FOR UPDATE) r;
  SELECT coalesce(array_agg("id"), '{}') INTO messages FROM (
    SELECT "id" FROM "Message"
     WHERE "workspaceId" = ws AND "threadId" = ANY(threads) FOR UPDATE) r;
  SELECT coalesce(array_agg("id"), '{}'), coalesce(array_agg("storageKey"), '{}')
    INTO assets, objects FROM (
    SELECT "id", "storageKey" FROM "Asset"
     WHERE "workspaceId" = ws
       AND ("listingId" = p_listing_id OR "taskId" = ANY(tasks)) FOR UPDATE) r;
  owned := ARRAY[p_listing_id] || connections || blocks || reservations
    || conflicts || tasks || threads || messages || assets;

  -- Queued work about any of it: guest replies, cleaner notices, message
  -- evaluations. One being handed to a provider right now cannot be recalled.
  SELECT coalesce(array_agg("id"), '{}') INTO jobs FROM (
    SELECT "id" FROM "Outbox"
     WHERE "workspaceId" = ws AND "entityId" = ANY(owned) FOR UPDATE) r;
  IF EXISTS (SELECT 1 FROM "Outbox" WHERE "id" = ANY(jobs) AND "status" = 'SENDING') THEN
    RAISE EXCEPTION 'A message about this property is being sent right now'
      USING ERRCODE = 'lock_not_available';
  END IF;
  -- Alerts name what they are about in their key ("cal:conflict:<id>:…",
  -- "cleaning-cancelled:<id>") or their link ("/inbox?thread=<id>"), and
  -- their text can name the property, so they go too, with their pushes.
  SELECT coalesce(array_agg(DISTINCT n."id"), '{}') INTO notifications
    FROM "Notification" n
    CROSS JOIN LATERAL unnest(
      string_to_array(n."key", ':') || regexp_split_to_array(n."href", '[/?&=#]')
    ) AS part(value)
    JOIN unnest(owned || jobs) AS mine(id) ON mine.id = part.value
   WHERE n."workspaceId" = ws;
  SELECT jobs || coalesce(array_agg("id"), '{}') INTO jobs FROM (
    SELECT "id" FROM "Outbox"
     WHERE "workspaceId" = ws AND "kind" = 'PUSH'
       AND "entityId" = ANY(notifications) AND NOT ("id" = ANY(jobs))
       FOR UPDATE) r;
  IF EXISTS (SELECT 1 FROM "Outbox" WHERE "id" = ANY(jobs) AND "status" = 'SENDING') THEN
    RAISE EXCEPTION 'A message about this property is being sent right now'
      USING ERRCODE = 'lock_not_available';
  END IF;

  DELETE FROM "Outbox" WHERE "workspaceId" = ws AND "id" = ANY(jobs);
  DELETE FROM "Notification" WHERE "workspaceId" = ws AND "id" = ANY(notifications);
  DELETE FROM "MagicLink" WHERE "workspaceId" = ws AND "taskId" = ANY(tasks);
  UPDATE "CleaningTask" SET "photoId" = NULL
    WHERE "workspaceId" = ws AND "id" = ANY(tasks) AND "photoId" IS NOT NULL;
  DELETE FROM "Asset" WHERE "workspaceId" = ws AND "id" = ANY(assets);
  DELETE FROM "Message" WHERE "workspaceId" = ws AND "id" = ANY(messages);
  DELETE FROM "Thread" WHERE "workspaceId" = ws AND "id" = ANY(threads);
  DELETE FROM "ConflictCase" WHERE "workspaceId" = ws AND "id" = ANY(conflicts);
  DELETE FROM "CleaningTask" WHERE "workspaceId" = ws AND "id" = ANY(tasks);
  DELETE FROM "Reservation" WHERE "workspaceId" = ws AND "id" = ANY(reservations);
  DELETE FROM "AvailabilityBlock" WHERE "workspaceId" = ws AND "id" = ANY(blocks);
  DELETE FROM "ExportVersion" WHERE "workspaceId" = ws AND "connectionId" = ANY(connections);
  GET DIAGNOSTICS versions = ROW_COUNT;
  DELETE FROM "ExportRetrieval" WHERE "workspaceId" = ws AND "connectionId" = ANY(connections);
  DELETE FROM "RevokedExportToken" WHERE "workspaceId" = ws AND "connectionId" = ANY(connections);
  DELETE FROM "FeedObservation" WHERE "workspaceId" = ws AND "connectionId" = ANY(connections);
  GET DIAGNOSTICS observations = ROW_COUNT;
  -- Setup that pointed at it starts again from choosing a property, exactly
  -- as setup treats a removed property.
  UPDATE "OnboardingProgress" SET
      "listingId" = NULL,
      "connectionId" = NULL,
      "exportConfirmedAt" = CASE WHEN "step" = 'DONE' THEN "exportConfirmedAt" END,
      "completed" = CASE WHEN "step" = 'DONE' THEN "completed"
        ELSE array_remove(array_remove(array_remove("completed", 'PROPERTY'), 'CALENDAR'), 'EXPORT') END,
      "skipped" = CASE WHEN "step" = 'DONE' THEN "skipped"
        ELSE array_remove(array_remove("skipped", 'CALENDAR'), 'EXPORT') END,
      "step" = CASE WHEN "step" = 'DONE' THEN 'DONE' ELSE 'PROPERTY' END
    WHERE "workspaceId" = ws
      AND ("listingId" = p_listing_id OR "connectionId" = ANY(connections));
  DELETE FROM "AutomationRule" WHERE "workspaceId" = ws AND "listingId" = p_listing_id;
  -- Cleaners stay on the team; only this property leaves their list.
  UPDATE "Cleaner" SET "listingIds" = array_remove("listingIds", p_listing_id)
    WHERE "workspaceId" = ws AND p_listing_id = ANY("listingIds");
  DELETE FROM "ChannelConnection" WHERE "workspaceId" = ws AND "id" = ANY(connections);
  DELETE FROM "Listing" WHERE "workspaceId" = ws AND "id" = p_listing_id;

  counts := jsonb_build_object(
    'calendarLinks', cardinality(connections),
    'calendarChecks', observations,
    'exportVersions', versions,
    'dateRanges', cardinality(blocks),
    'stays', cardinality(reservations),
    'overlaps', cardinality(conflicts),
    'cleanings', cardinality(tasks),
    'conversations', cardinality(threads),
    'messages', cardinality(messages),
    'photos', cardinality(assets),
    'alerts', cardinality(notifications),
    'queuedWork', cardinality(jobs)
  );
  INSERT INTO "Erasure" ("id", "workspaceId", "subject", "subjectId", "trigger", "actorId", "counts", "pendingObjects")
    VALUES (erasure_id, ws, 'LISTING', p_listing_id, p_trigger, p_actor, counts, objects);
  RETURN jsonb_build_object('id', erasure_id, 'counts', counts, 'objects', to_jsonb(objects));
END $$;
REVOKE ALL ON FUNCTION erase_listing(TEXT, TEXT, TEXT) FROM PUBLIC;
