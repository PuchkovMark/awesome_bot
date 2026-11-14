-- Add fields for background subagent jobs.
ALTER TABLE "DigestJob" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'digest';
ALTER TABLE "DigestJob" ADD COLUMN "instruction" TEXT;
ALTER TABLE "DigestJob" ADD COLUMN "format" TEXT;
ALTER TABLE "DigestJob" ADD COLUMN "maxOutputChars" INTEGER NOT NULL DEFAULT 3500;
ALTER TABLE "DigestJob" ADD COLUMN "parts" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "DigestJob" ADD COLUMN "partResults" TEXT;
ALTER TABLE "DigestJob" ADD COLUMN "resultSentAt" DATETIME;

CREATE INDEX "DigestJob_conversationId_createdAt_idx" ON "DigestJob"("conversationId", "createdAt");

-- Old digest jobs used conversationId:userId as activeKey. Clear it so the
-- recovery pass can enforce one active job per conversation.
UPDATE "DigestJob" SET "activeKey" = NULL;

