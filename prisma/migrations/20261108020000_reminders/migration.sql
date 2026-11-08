CREATE TABLE "Reminder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "creatorVkId" TEXT NOT NULL,
    "recipientVkId" TEXT,
    "sourcePeerId" TEXT NOT NULL,
    "deliveryPeerId" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'personal',
    "content" TEXT NOT NULL,
    "timeZone" TEXT NOT NULL,
    "nextRunAt" DATETIME,
    "recurrenceRule" TEXT,
    "recurrenceEndAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'active',
    "deliveryMode" TEXT NOT NULL DEFAULT 'private',
    "fallbackState" TEXT NOT NULL DEFAULT 'none',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Reminder_sourcePeerId_fkey" FOREIGN KEY ("sourcePeerId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ReminderDelivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reminderId" TEXT NOT NULL,
    "occurrenceAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockUntil" DATETIME,
    "randomId" INTEGER NOT NULL,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ReminderDelivery_reminderId_fkey" FOREIGN KEY ("reminderId") REFERENCES "Reminder" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ReminderDraft" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "creatorVkId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE INDEX "Reminder_status_nextRunAt_idx" ON "Reminder"("status", "nextRunAt");
CREATE INDEX "Reminder_creatorVkId_scope_status_idx" ON "Reminder"("creatorVkId", "scope", "status");
CREATE INDEX "Reminder_sourcePeerId_scope_status_idx" ON "Reminder"("sourcePeerId", "scope", "status");
CREATE UNIQUE INDEX "ReminderDelivery_reminderId_occurrenceAt_key" ON "ReminderDelivery"("reminderId", "occurrenceAt");
CREATE INDEX "ReminderDelivery_status_nextAttemptAt_idx" ON "ReminderDelivery"("status", "nextAttemptAt");
CREATE INDEX "ReminderDelivery_reminderId_occurrenceAt_idx" ON "ReminderDelivery"("reminderId", "occurrenceAt");
CREATE UNIQUE INDEX "ReminderDraft_creatorVkId_conversationId_key" ON "ReminderDraft"("creatorVkId", "conversationId");
CREATE INDEX "ReminderDraft_expiresAt_idx" ON "ReminderDraft"("expiresAt");
