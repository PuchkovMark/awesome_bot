ALTER TABLE "ChatSettings" ADD COLUMN "memeDaySettings" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "ChatSettings" ADD COLUMN "memeDayWeeklyEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "MemeDayPublication" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "conversationId" TEXT NOT NULL,
  "funOutputId" TEXT,
  "kind" TEXT NOT NULL,
  "topic" TEXT NOT NULL,
  "caption" TEXT NOT NULL,
  "imageUrl" TEXT,
  "attachment" TEXT,
  "scheduleKey" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" DATETIME,
  "lockUntil" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MemeDayPublication_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "MemeDayPublication_scheduleKey_key" ON "MemeDayPublication"("scheduleKey");
CREATE INDEX "MemeDayPublication_conversationId_kind_createdAt_idx"
  ON "MemeDayPublication"("conversationId", "kind", "createdAt");

CREATE TABLE "MemeDayVote" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "publicationId" TEXT NOT NULL,
  "vkUserId" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MemeDayVote_publicationId_fkey"
    FOREIGN KEY ("publicationId") REFERENCES "MemeDayPublication"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MemeDayVote_publicationId_vkUserId_key" UNIQUE ("publicationId", "vkUserId")
);
CREATE INDEX "MemeDayVote_publicationId_value_idx" ON "MemeDayVote"("publicationId", "value");
