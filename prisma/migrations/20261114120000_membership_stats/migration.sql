-- CreateTable
CREATE TABLE "MembershipEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "memberType" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "actorId" TEXT,
    "occurredAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ChatSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'normal',
    "imageAccess" TEXT NOT NULL DEFAULT 'admins_only',
    "welcomeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "welcomeText" TEXT NOT NULL DEFAULT 'Добро пожаловать, {name}! Рады видеть тебя в беседе.',
    "questionnaireEnabled" BOOLEAN NOT NULL DEFAULT false,
    "questionnaireQuestions" TEXT NOT NULL DEFAULT '["Сколько лет?","Как к тебе обращаться? (Имя или позывной?)","Работаешь или учишься?","На кого/кем?","Семейное положение: в поиске своего счастья или уже есть вторая половинка?","Сколько в ВРН?","Где любишь гулять?","Кофе или чай?","Какие хобби?","Есть любимые фильмы?","Скинь пару любимых песен.","Ты за активный отдых или лучше фильмец дома глянуть?","Как относишься к алкоголю?","50/50 на первом свидании норм?","Что ждёшь от этой конфы?","Какой MBTI? Ссылка на тест: https://www.16personalities.com/ru"]',
    "personality" TEXT NOT NULL DEFAULT 'chipsik',
    "systemPrompt" TEXT,
    "personalitySettings" TEXT NOT NULL DEFAULT '{}',
    "allowPersonalityChange" BOOLEAN NOT NULL DEFAULT false,
    "funAutoReactions" BOOLEAN NOT NULL DEFAULT false,
    "funAutoReactionAt" DATETIME,
    "funAutoIntervalSeconds" INTEGER NOT NULL DEFAULT 300,
    "funAutoProbability" INTEGER NOT NULL DEFAULT 10,
    "funSettings" TEXT NOT NULL DEFAULT '{}',
    "memeDaySettings" TEXT NOT NULL DEFAULT '{}',
    "memeDayWeeklyEnabled" BOOLEAN NOT NULL DEFAULT false,
    "locationName" TEXT,
    "locationLatitude" REAL,
    "locationLongitude" REAL,
    "locationCountry" TEXT,
    "locationRegion" TEXT,
    "locationTimeZone" TEXT,
    "timeZone" TEXT,
    "memoryEnabled" BOOLEAN NOT NULL DEFAULT true,
    "autoMemoryEnabled" BOOLEAN NOT NULL DEFAULT true,
    "membershipTrackingSince" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "membershipLastSyncDay" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ChatSettings_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ChatSettings" ("allowPersonalityChange", "autoMemoryEnabled", "conversationId", "createdAt", "funAutoIntervalSeconds", "funAutoProbability", "funAutoReactionAt", "funAutoReactions", "funSettings", "id", "imageAccess", "locationCountry", "locationLatitude", "locationLongitude", "locationName", "locationRegion", "locationTimeZone", "memeDaySettings", "memeDayWeeklyEnabled", "memoryEnabled", "mode", "personality", "personalitySettings", "questionnaireEnabled", "questionnaireQuestions", "systemPrompt", "timeZone", "updatedAt", "welcomeEnabled", "welcomeText") SELECT "allowPersonalityChange", "autoMemoryEnabled", "conversationId", "createdAt", "funAutoIntervalSeconds", "funAutoProbability", "funAutoReactionAt", "funAutoReactions", "funSettings", "id", "imageAccess", "locationCountry", "locationLatitude", "locationLongitude", "locationName", "locationRegion", "locationTimeZone", "memeDaySettings", "memeDayWeeklyEnabled", "memoryEnabled", "mode", "personality", "personalitySettings", "questionnaireEnabled", "questionnaireQuestions", "systemPrompt", "timeZone", "updatedAt", "welcomeEnabled", "welcomeText" FROM "ChatSettings";
DROP TABLE "ChatSettings";
ALTER TABLE "new_ChatSettings" RENAME TO "ChatSettings";
CREATE UNIQUE INDEX "ChatSettings_conversationId_key" ON "ChatSettings"("conversationId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "MembershipEvent_conversationId_occurredAt_idx" ON "MembershipEvent"("conversationId", "occurredAt");

-- CreateIndex
CREATE INDEX "MembershipEvent_conversationId_memberId_occurredAt_idx" ON "MembershipEvent"("conversationId", "memberId", "occurredAt");

-- CreateIndex
CREATE INDEX "MembershipEvent_conversationId_type_occurredAt_idx" ON "MembershipEvent"("conversationId", "type", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "MembershipEvent_conversationId_eventId_key" ON "MembershipEvent"("conversationId", "eventId");
