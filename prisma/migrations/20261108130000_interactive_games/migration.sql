CREATE TABLE "GameEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "vkUserId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GameEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "GameSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "GamePlayerStats" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scope" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "vkUserId" TEXT NOT NULL,
    "gamesPlayed" INTEGER NOT NULL DEFAULT 0,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "answers" INTEGER NOT NULL DEFAULT 0,
    "correctAnswers" INTEGER NOT NULL DEFAULT 0,
    "bestScore" INTEGER NOT NULL DEFAULT 0,
    "currentWinStreak" INTEGER NOT NULL DEFAULT 0,
    "bestWinStreak" INTEGER NOT NULL DEFAULT 0,
    "excludedFromGlobal" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "GameEvent_sessionId_eventId_key" ON "GameEvent"("sessionId", "eventId");
CREATE INDEX "GameEvent_sessionId_createdAt_idx" ON "GameEvent"("sessionId", "createdAt");
CREATE UNIQUE INDEX "GamePlayerStats_scope_scopeId_vkUserId_key" ON "GamePlayerStats"("scope", "scopeId", "vkUserId");
CREATE INDEX "GamePlayerStats_scope_scopeId_bestScore_idx" ON "GamePlayerStats"("scope", "scopeId", "bestScore");
CREATE INDEX "GamePlayerStats_vkUserId_scope_idx" ON "GamePlayerStats"("vkUserId", "scope");
