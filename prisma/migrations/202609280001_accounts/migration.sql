-- Self-service accounts (AUTH 01, AUTH 03) and guided setup progress
-- (AUTH 04). Additive only: no existing table or column changes, so the
-- previous release keeps working whether this runs before or after it is
-- replaced (MIG 01 expand step).

-- ---------------------------------------------------------------------------
-- Sign-up waiting for email verification (AUTH 01). No user, workspace or
-- session exists until the emailed link is used, so sign-in never sees an
-- unverified account. Server-only, like "User" and "Session": it is read by
-- token hash before any workspace exists, so it is outside tenant RLS.
-- ---------------------------------------------------------------------------
CREATE TABLE "PendingRegistration" (
    "id" TEXT NOT NULL,
    "emailHash" TEXT NOT NULL,
    "emailEncrypted" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "workspaceName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PendingRegistration_pkey" PRIMARY KEY ("id"),
    CONSTRAINT pending_registration_expiry CHECK ("expiresAt" > "createdAt")
);
CREATE UNIQUE INDEX "PendingRegistration_emailHash_key" ON "PendingRegistration"("emailHash");
CREATE UNIQUE INDEX "PendingRegistration_tokenHash_key" ON "PendingRegistration"("tokenHash");
CREATE INDEX "PendingRegistration_expiresAt_idx" ON "PendingRegistration"("expiresAt");

-- ---------------------------------------------------------------------------
-- Password reset links (AUTH 03): random, stored only as a hash, single use,
-- valid for thirty minutes.
-- ---------------------------------------------------------------------------
CREATE TABLE "PasswordReset" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PasswordReset_pkey" PRIMARY KEY ("id"),
    CONSTRAINT password_reset_user_fk FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE,
    CONSTRAINT password_reset_window CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + interval '30 minutes')
);
CREATE UNIQUE INDEX "PasswordReset_tokenHash_key" ON "PasswordReset"("tokenHash");
CREATE INDEX "PasswordReset_userId_idx" ON "PasswordReset"("userId");
CREATE INDEX "PasswordReset_expiresAt_idx" ON "PasswordReset"("expiresAt");

-- ---------------------------------------------------------------------------
-- Guided setup progress, one row per workspace (AUTH 04). Tenant data under
-- forced RLS; the property and connection it points to must belong to the
-- same workspace.
-- ---------------------------------------------------------------------------
CREATE TABLE "OnboardingProgress" (
    "workspaceId" TEXT NOT NULL,
    "step" TEXT NOT NULL DEFAULT 'PROPERTY',
    "completed" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "skipped" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "listingId" TEXT,
    "connectionId" TEXT,
    -- The host's own statement that they added the export link to the
    -- platform, kept apart from any observed retrieval (EXPORT 02).
    "exportConfirmedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OnboardingProgress_pkey" PRIMARY KEY ("workspaceId"),
    CONSTRAINT onboarding_workspace_fk FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT,
    CONSTRAINT onboarding_listing_fk FOREIGN KEY ("workspaceId","listingId") REFERENCES "Listing"("workspaceId","id"),
    CONSTRAINT onboarding_connection_fk FOREIGN KEY ("workspaceId","connectionId") REFERENCES "ChannelConnection"("workspaceId","id"),
    CONSTRAINT onboarding_step CHECK ("step" IN ('PROPERTY','CALENDAR','EXPORT','CLEANER','REHEARSAL','DONE')),
    CONSTRAINT onboarding_steps CHECK (
      "completed" <@ ARRAY['PROPERTY','CALENDAR','EXPORT','CLEANER','REHEARSAL']::TEXT[]
      AND "skipped" <@ ARRAY['CALENDAR','EXPORT','CLEANER']::TEXT[]
    ),
    CONSTRAINT onboarding_done CHECK (("step" = 'DONE') = ("completedAt" IS NOT NULL))
);
ALTER TABLE "OnboardingProgress" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OnboardingProgress" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON "OnboardingProgress"
  USING ("workspaceId" = nullif(current_setting('app.workspace_id', true), ''))
  WITH CHECK ("workspaceId" = nullif(current_setting('app.workspace_id', true), ''));
