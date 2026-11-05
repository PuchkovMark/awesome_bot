-- CreateTable
CREATE TABLE "UserSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "personality" TEXT NOT NULL DEFAULT 'friendly',
    "systemPrompt" TEXT,
    "voiceEnabled" BOOLEAN NOT NULL DEFAULT false,
    "voice" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UserSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ChatSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'normal',
    "imageAccess" TEXT NOT NULL DEFAULT 'admins_only',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ChatSettings_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Admin" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vkId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GameSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "game" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'active',
    "data" TEXT NOT NULL DEFAULT '{}',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "endedAt" DATETIME,
    CONSTRAINT "GameSession_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GameScore" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "vkUserId" TEXT NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GameScore_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "GameSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Achievement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vkUserId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "metadata" TEXT,
    "earnedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ApiUsage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vkUserId" TEXT,
    "conversationId" TEXT,
    "provider" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "estimatedCost" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AdminLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "adminVkId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "details" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "UserSettings_userId_key" ON "UserSettings"("userId");
CREATE UNIQUE INDEX "ChatSettings_conversationId_key" ON "ChatSettings"("conversationId");
CREATE UNIQUE INDEX "Admin_vkId_key" ON "Admin"("vkId");
CREATE INDEX "GameSession_conversationId_state_idx" ON "GameSession"("conversationId", "state");
CREATE UNIQUE INDEX "GameScore_sessionId_vkUserId_key" ON "GameScore"("sessionId", "vkUserId");
CREATE INDEX "GameScore_vkUserId_createdAt_idx" ON "GameScore"("vkUserId", "createdAt");
CREATE UNIQUE INDEX "Achievement_vkUserId_code_key" ON "Achievement"("vkUserId", "code");
CREATE INDEX "Achievement_vkUserId_earnedAt_idx" ON "Achievement"("vkUserId", "earnedAt");
CREATE INDEX "ApiUsage_createdAt_idx" ON "ApiUsage"("createdAt");
CREATE INDEX "ApiUsage_vkUserId_createdAt_idx" ON "ApiUsage"("vkUserId", "createdAt");
CREATE INDEX "AdminLog_createdAt_idx" ON "AdminLog"("createdAt");
CREATE INDEX "AdminLog_adminVkId_createdAt_idx" ON "AdminLog"("adminVkId", "createdAt");
CREATE INDEX "Message_userId_conversationId_createdAt_idx" ON "Message"("userId", "conversationId", "createdAt");
