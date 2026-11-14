-- CreateTable
CREATE TABLE "DigestJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "activeKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requestedCount" INTEGER,
    "rangeFrom" DATETIME,
    "rangeTo" DATETIME,
    "maxDigestChars" INTEGER NOT NULL DEFAULT 15000,
    "messageId" INTEGER,
    "conversationMessageId" INTEGER,
    "digests" TEXT,
    "result" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "completedAt" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "DigestJob_activeKey_key" ON "DigestJob"("activeKey");

-- CreateIndex
CREATE INDEX "DigestJob_conversationId_userId_idx" ON "DigestJob"("conversationId", "userId");

-- CreateIndex
CREATE INDEX "DigestJob_status_updatedAt_idx" ON "DigestJob"("status", "updatedAt");
