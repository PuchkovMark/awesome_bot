-- CreateTable
CREATE TABLE "LongTermMemory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scope" TEXT NOT NULL,
    "userId" TEXT,
    "conversationId" TEXT,
    "createdByVkId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "importance" REAL NOT NULL DEFAULT 0.5,
    "confidence" REAL NOT NULL DEFAULT 1,
    "source" TEXT NOT NULL DEFAULT 'automatic',
    "fingerprint" TEXT NOT NULL,
    "embedding" TEXT,
    "embeddingModel" TEXT,
    "relatedMemoryIds" TEXT NOT NULL DEFAULT '[]',
    "expiresAt" DATETIME,
    "archivedAt" DATETIME,
    "lastAccessedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "LongTermMemory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LongTermMemory_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MemoryActionDraft" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "candidateIds" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MemoryActionDraft_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MemoryActionDraft_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- AlterTable
ALTER TABLE "UserSettings" ADD COLUMN "memoryEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "UserSettings" ADD COLUMN "autoMemoryEnabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "ChatSettings" ADD COLUMN "memoryEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ChatSettings" ADD COLUMN "autoMemoryEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE UNIQUE INDEX "LongTermMemory_userId_fingerprint_key" ON "LongTermMemory"("userId", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "LongTermMemory_conversationId_fingerprint_key" ON "LongTermMemory"("conversationId", "fingerprint");

-- CreateIndex
CREATE INDEX "LongTermMemory_userId_archivedAt_updatedAt_idx" ON "LongTermMemory"("userId", "archivedAt", "updatedAt");

-- CreateIndex
CREATE INDEX "LongTermMemory_conversationId_archivedAt_updatedAt_idx" ON "LongTermMemory"("conversationId", "archivedAt", "updatedAt");

-- CreateIndex
CREATE INDEX "LongTermMemory_category_idx" ON "LongTermMemory"("category");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryActionDraft_userId_conversationId_key" ON "MemoryActionDraft"("userId", "conversationId");

-- CreateIndex
CREATE INDEX "MemoryActionDraft_expiresAt_idx" ON "MemoryActionDraft"("expiresAt");
