-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "emailHash" TEXT NOT NULL,
    "emailEncrypted" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'COHOST',

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimit" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimit_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "Listing" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/Los_Angeles',
    "color" TEXT NOT NULL DEFAULT '#a8c9b8',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "doorCodeEncrypted" TEXT,
    "houseManualEncrypted" TEXT NOT NULL,
    "bufferDays" INTEGER NOT NULL DEFAULT 1,
    "checkoutHour" INTEGER NOT NULL DEFAULT 11,
    "cleaningBufferHours" INTEGER NOT NULL DEFAULT 4,
    "photoIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ready" BOOLEAN NOT NULL DEFAULT false,
    "exportTokenHash" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Listing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncSource" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "urlEncrypted" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'IMPORT',
    "tokenHash" TEXT NOT NULL,
    "lastSyncedAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "nextPollAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "etag" TEXT,
    "lastModified" TEXT,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMP(3),
    "leaseToken" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "events" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "sourceId" TEXT,
    "externalUid" TEXT NOT NULL,
    "guestNameEncrypted" TEXT,
    "guestContactEncrypted" TEXT,
    "guestHash" TEXT,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "platform" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CONFIRMED',
    "kind" TEXT NOT NULL DEFAULT 'RESERVATION',
    "reason" TEXT,
    "price" DECIMAL(12,2),
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "confirmedAt" TIMESTAMP(3) NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "missingCount" INTEGER NOT NULL DEFAULT 0,
    "priorityOverride" BOOLEAN NOT NULL DEFAULT false,
    "conflictWithId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cleaner" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phoneEncrypted" TEXT NOT NULL,
    "listingIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Cleaner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CleaningTask" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "bookingId" TEXT,
    "cleanerId" TEXT,
    "title" TEXT NOT NULL DEFAULT 'Guest-ready turnover',
    "status" TEXT NOT NULL DEFAULT 'NEEDS_SCHEDULING',
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "acceptBy" TIMESTAMP(3),
    "verifyBy" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "photoId" TEXT,
    "codeReleasedAt" TIMESTAMP(3),
    "noteEncrypted" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CleaningTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MagicLink" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "cleanerId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "redeemedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "sessionHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MagicLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "taskId" TEXT,
    "listingId" TEXT,
    "storageKey" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Thread" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NEEDS_REPLY',
    "intent" TEXT NOT NULL DEFAULT 'QUESTION',
    "manual" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Thread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "externalId" TEXT,
    "bodyEncrypted" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "automated" BOOLEAN NOT NULL DEFAULT false,
    "aiConfidence" DOUBLE PRECISION,
    "ruleId" TEXT,
    "replyToId" TEXT,
    "explanation" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationSettings" (
    "workspaceId" TEXT NOT NULL,
    "paused" BOOLEAN NOT NULL DEFAULT true,
    "cleaning" BOOLEAN NOT NULL DEFAULT false,
    "messaging" BOOLEAN NOT NULL DEFAULT false,
    "ai" BOOLEAN NOT NULL DEFAULT false,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.98,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationSettings_pkey" PRIMARY KEY ("workspaceId")
);

-- CreateTable
CREATE TABLE "AutomationRule" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "listingId" TEXT,
    "name" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'GUEST_MESSAGE',
    "keywords" TEXT[],
    "manualField" TEXT,
    "templateEncrypted" TEXT NOT NULL,
    "action" TEXT NOT NULL DEFAULT 'DRAFT',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DomainEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DomainEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Outbox" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "payloadEncrypted" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "automated" BOOLEAN NOT NULL DEFAULT true,
    "category" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "dueAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3),
    "leaseToken" TEXT,
    "providerId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "reason" TEXT NOT NULL,
    "detailEncrypted" TEXT,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "href" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpointHash" TEXT NOT NULL,
    "subscriptionEncrypted" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Integration" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "endpointEncrypted" TEXT NOT NULL,
    "secretEncrypted" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_emailHash_key" ON "User"("emailHash");

-- CreateIndex
CREATE INDEX "Membership_userId_idx" ON "Membership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_workspaceId_userId_key" ON "Membership"("workspaceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Listing_exportTokenHash_key" ON "Listing"("exportTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Listing_workspaceId_id_key" ON "Listing"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SyncSource_tokenHash_key" ON "SyncSource"("tokenHash");

-- CreateIndex
CREATE INDEX "SyncSource_workspaceId_nextPollAt_idx" ON "SyncSource"("workspaceId", "nextPollAt");

-- CreateIndex
CREATE UNIQUE INDEX "SyncSource_workspaceId_id_key" ON "SyncSource"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SyncSource_workspaceId_listingId_platform_direction_key" ON "SyncSource"("workspaceId", "listingId", "platform", "direction");

-- CreateIndex
CREATE INDEX "SyncRun_workspaceId_createdAt_idx" ON "SyncRun"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "Booking_workspaceId_listingId_startDate_endDate_idx" ON "Booking"("workspaceId", "listingId", "startDate", "endDate");

-- CreateIndex
CREATE INDEX "Booking_workspaceId_status_idx" ON "Booking"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_workspaceId_id_key" ON "Booking"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_workspaceId_listingId_platform_externalUid_key" ON "Booking"("workspaceId", "listingId", "platform", "externalUid");

-- CreateIndex
CREATE UNIQUE INDEX "Cleaner_workspaceId_id_key" ON "Cleaner"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "CleaningTask_workspaceId_status_scheduledAt_idx" ON "CleaningTask"("workspaceId", "status", "scheduledAt");

-- CreateIndex
CREATE UNIQUE INDEX "CleaningTask_workspaceId_id_key" ON "CleaningTask"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CleaningTask_workspaceId_bookingId_key" ON "CleaningTask"("workspaceId", "bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "MagicLink_tokenHash_key" ON "MagicLink"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "MagicLink_sessionHash_key" ON "MagicLink"("sessionHash");

-- CreateIndex
CREATE INDEX "MagicLink_workspaceId_taskId_idx" ON "MagicLink"("workspaceId", "taskId");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_storageKey_key" ON "Asset"("storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_workspaceId_id_key" ON "Asset"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Thread_workspaceId_id_key" ON "Thread"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Thread_workspaceId_platform_externalId_key" ON "Thread"("workspaceId", "platform", "externalId");

-- CreateIndex
CREATE INDEX "Message_workspaceId_threadId_createdAt_idx" ON "Message"("workspaceId", "threadId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Message_workspaceId_id_key" ON "Message"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Message_workspaceId_threadId_externalId_key" ON "Message"("workspaceId", "threadId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationRule_workspaceId_id_key" ON "AutomationRule"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "DomainEvent_workspaceId_entityId_createdAt_idx" ON "DomainEvent"("workspaceId", "entityId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DomainEvent_workspaceId_key_key" ON "DomainEvent"("workspaceId", "key");

-- CreateIndex
CREATE INDEX "Outbox_workspaceId_status_dueAt_idx" ON "Outbox"("workspaceId", "status", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "Outbox_workspaceId_key_key" ON "Outbox"("workspaceId", "key");

-- CreateIndex
CREATE INDEX "AuditLog_workspaceId_createdAt_idx" ON "AuditLog"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_workspaceId_entityId_idx" ON "AuditLog"("workspaceId", "entityId");

-- CreateIndex
CREATE INDEX "Notification_workspaceId_createdAt_idx" ON "Notification"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_workspaceId_key_key" ON "Notification"("workspaceId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_endpointHash_key" ON "PushSubscription"("endpointHash");

-- CreateIndex
CREATE UNIQUE INDEX "Integration_workspaceId_platform_key" ON "Integration"("workspaceId", "platform");

