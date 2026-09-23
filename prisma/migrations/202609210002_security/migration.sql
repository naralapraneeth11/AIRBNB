-- Tenant isolation is enforced in Postgres as well as at every HTTP boundary.
-- Auth/capability lookup tables (User, Session, Membership, MagicLink) intentionally
-- remain outside tenant RLS: a credential must first resolve its workspace.
-- They are accessible only to the server's restricted database role.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['Listing','SyncSource','SyncRun','Booking','Cleaner','CleaningTask','Asset','Thread','Message','AutomationSettings','AutomationRule','DomainEvent','Outbox','AuditLog','Notification','PushSubscription','Integration'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_scope ON %I USING ("workspaceId" = nullif(current_setting(''app.workspace_id'',true),'''')) WITH CHECK ("workspaceId" = nullif(current_setting(''app.workspace_id'',true),''''))',t);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT',t,t||'_workspace_fk');
  END LOOP;
END $$;
ALTER TABLE "Membership" ADD CONSTRAINT membership_workspace_fk FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id");
ALTER TABLE "Membership" ADD CONSTRAINT membership_user_fk FOREIGN KEY ("userId") REFERENCES "User"("id");
ALTER TABLE "Membership" ADD CONSTRAINT membership_role CHECK (role IN ('HOST','COHOST'));
ALTER TABLE "Session" ADD CONSTRAINT session_membership_fk FOREIGN KEY ("workspaceId","userId") REFERENCES "Membership"("workspaceId","userId") ON DELETE CASCADE;
ALTER TABLE "Listing" ADD CONSTRAINT listing_buffers CHECK ("bufferDays" BETWEEN 0 AND 14 AND "checkoutHour" BETWEEN 0 AND 23 AND "cleaningBufferHours" BETWEEN 1 AND 48);
ALTER TABLE "Booking" ADD CONSTRAINT booking_dates CHECK ("endDate">"startDate");
ALTER TABLE "Booking" ADD CONSTRAINT booking_price CHECK (price IS NULL OR price>=0);
ALTER TABLE "Booking" ADD CONSTRAINT booking_status CHECK (status IN ('CONFIRMED','CONFLICT','CANCELLED','DISMISSED','PENDING_REMOVAL'));
ALTER TABLE "Booking" ADD CONSTRAINT booking_kind CHECK (kind IN ('RESERVATION','BLOCK'));
ALTER TABLE "Booking" ADD CONSTRAINT booking_listing_fk FOREIGN KEY ("workspaceId","listingId") REFERENCES "Listing"("workspaceId","id");
ALTER TABLE "Booking" ADD CONSTRAINT booking_source_fk FOREIGN KEY ("workspaceId","sourceId") REFERENCES "SyncSource"("workspaceId","id");
ALTER TABLE "Booking" ADD CONSTRAINT booking_conflict_fk FOREIGN KEY ("workspaceId","conflictWithId") REFERENCES "Booking"("workspaceId","id");
ALTER TABLE "SyncSource" ADD CONSTRAINT source_listing_fk FOREIGN KEY ("workspaceId","listingId") REFERENCES "Listing"("workspaceId","id");
ALTER TABLE "SyncRun" ADD CONSTRAINT run_source_fk FOREIGN KEY ("workspaceId","sourceId") REFERENCES "SyncSource"("workspaceId","id");
ALTER TABLE "CleaningTask" ADD CONSTRAINT task_listing_fk FOREIGN KEY ("workspaceId","listingId") REFERENCES "Listing"("workspaceId","id");
ALTER TABLE "CleaningTask" ADD CONSTRAINT task_booking_fk FOREIGN KEY ("workspaceId","bookingId") REFERENCES "Booking"("workspaceId","id");
ALTER TABLE "CleaningTask" ADD CONSTRAINT task_cleaner_fk FOREIGN KEY ("workspaceId","cleanerId") REFERENCES "Cleaner"("workspaceId","id");
ALTER TABLE "CleaningTask" ADD CONSTRAINT task_status CHECK (status IN ('NEEDS_SCHEDULING','ASSIGNED','ACCEPTED','IN_PROGRESS','DONE','VERIFIED'));
ALTER TABLE "CleaningTask" ADD CONSTRAINT task_deadline CHECK ("verifyBy">"scheduledAt");
ALTER TABLE "CleaningTask" ADD CONSTRAINT verification_evidence CHECK (status <> 'VERIFIED' OR ("photoId" IS NOT NULL AND "verifiedAt" IS NOT NULL));
ALTER TABLE "CleaningTask" ADD CONSTRAINT accepted_before_code CHECK ("codeReleasedAt" IS NULL OR "acceptedAt" IS NOT NULL);
ALTER TABLE "MagicLink" ADD CONSTRAINT magic_task_fk FOREIGN KEY ("workspaceId","taskId") REFERENCES "CleaningTask"("workspaceId","id");
ALTER TABLE "MagicLink" ADD CONSTRAINT magic_cleaner_fk FOREIGN KEY ("workspaceId","cleanerId") REFERENCES "Cleaner"("workspaceId","id");
ALTER TABLE "Asset" ADD CONSTRAINT asset_task_fk FOREIGN KEY ("workspaceId","taskId") REFERENCES "CleaningTask"("workspaceId","id");
ALTER TABLE "Asset" ADD CONSTRAINT asset_listing_fk FOREIGN KEY ("workspaceId","listingId") REFERENCES "Listing"("workspaceId","id");
ALTER TABLE "CleaningTask" ADD CONSTRAINT task_photo_fk FOREIGN KEY ("workspaceId","photoId") REFERENCES "Asset"("workspaceId","id");
ALTER TABLE "Thread" ADD CONSTRAINT thread_listing_fk FOREIGN KEY ("workspaceId","listingId") REFERENCES "Listing"("workspaceId","id");
ALTER TABLE "Thread" ADD CONSTRAINT thread_booking_fk FOREIGN KEY ("workspaceId","bookingId") REFERENCES "Booking"("workspaceId","id");
ALTER TABLE "Thread" ADD CONSTRAINT thread_status CHECK (status IN ('NEEDS_REPLY','AI_DRAFTED','AUTOMATED','RESOLVED'));
ALTER TABLE "Message" ADD CONSTRAINT message_thread_fk FOREIGN KEY ("workspaceId","threadId") REFERENCES "Thread"("workspaceId","id");
ALTER TABLE "Message" ADD CONSTRAINT message_reply_fk FOREIGN KEY ("workspaceId","replyToId") REFERENCES "Message"("workspaceId","id");
ALTER TABLE "Message" ADD CONSTRAINT confidence_range CHECK ("aiConfidence" IS NULL OR "aiConfidence" BETWEEN 0 AND 1);
ALTER TABLE "AutomationSettings" ADD CONSTRAINT threshold_range CHECK (confidence BETWEEN 0.5 AND 1);
ALTER TABLE "AutomationRule" ADD CONSTRAINT rule_listing_fk FOREIGN KEY ("workspaceId","listingId") REFERENCES "Listing"("workspaceId","id");
CREATE FUNCTION prevent_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Audit history is append-only'; END $$;
CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
CREATE TRIGGER immutable_events BEFORE UPDATE OR DELETE ON "DomainEvent" FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
