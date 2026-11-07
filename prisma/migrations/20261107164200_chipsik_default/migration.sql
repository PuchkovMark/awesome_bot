UPDATE "UserSettings"
SET "personality" = 'chipsik'
WHERE "personality" = 'alex'
  AND NOT EXISTS (
    SELECT 1
    FROM "User" AS u
    JOIN "PersonalityChange" AS pc
      ON pc."conversationId" = u."vkId"
    WHERE u."id" = "UserSettings"."userId"
      AND pc."scope" = 'direct'
      AND pc."toId" = 'alex'
  );

UPDATE "ChatSettings"
SET "personality" = 'chipsik'
WHERE "personality" = 'alex'
  AND NOT EXISTS (
    SELECT 1
    FROM "PersonalityChange" AS pc
    WHERE pc."conversationId" = "ChatSettings"."conversationId"
      AND pc."scope" = 'chat'
      AND pc."toId" = 'alex'
  );

UPDATE "AppSetting"
SET "value" = 'chipsik', "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'default_personality';

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
    "questionnaireQuestions" TEXT NOT NULL DEFAULT '["Как к тебе обращаться?","Чем ты увлекаешься?","О чём тебе интересно общаться?"]',
    "personality" TEXT NOT NULL DEFAULT 'chipsik',
    "personalitySettings" TEXT NOT NULL DEFAULT '{}',
    "allowPersonalityChange" BOOLEAN NOT NULL DEFAULT false,
    "funAutoReactions" BOOLEAN NOT NULL DEFAULT false,
    "funAutoReactionAt" DATETIME,
    "funAutoIntervalSeconds" INTEGER NOT NULL DEFAULT 300,
    "funAutoProbability" INTEGER NOT NULL DEFAULT 10,
    "funSettings" TEXT NOT NULL DEFAULT '{}',
    "memeDaySettings" TEXT NOT NULL DEFAULT '{}',
    "memeDayWeeklyEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ChatSettings_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_ChatSettings" (
    "allowPersonalityChange", "conversationId", "createdAt", "funAutoIntervalSeconds",
    "funAutoProbability", "funAutoReactionAt", "funAutoReactions", "funSettings", "id",
    "imageAccess", "memeDaySettings", "memeDayWeeklyEnabled", "mode", "personality",
    "personalitySettings", "questionnaireEnabled", "questionnaireQuestions", "updatedAt",
    "welcomeEnabled", "welcomeText"
)
SELECT
    "allowPersonalityChange", "conversationId", "createdAt", "funAutoIntervalSeconds",
    "funAutoProbability", "funAutoReactionAt", "funAutoReactions", "funSettings", "id",
    "imageAccess", "memeDaySettings", "memeDayWeeklyEnabled", "mode", "personality",
    "personalitySettings", "questionnaireEnabled", "questionnaireQuestions", "updatedAt",
    "welcomeEnabled", "welcomeText"
FROM "ChatSettings";

DROP TABLE "ChatSettings";
ALTER TABLE "new_ChatSettings" RENAME TO "ChatSettings";
CREATE UNIQUE INDEX "ChatSettings_conversationId_key" ON "ChatSettings"("conversationId");

CREATE TABLE "new_UserSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "personality" TEXT NOT NULL DEFAULT 'chipsik',
    "systemPrompt" TEXT,
    "voiceEnabled" BOOLEAN NOT NULL DEFAULT false,
    "voice" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UserSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_UserSettings" (
    "createdAt", "id", "personality", "systemPrompt", "updatedAt", "userId", "voice",
    "voiceEnabled"
)
SELECT
    "createdAt", "id", "personality", "systemPrompt", "updatedAt", "userId", "voice",
    "voiceEnabled"
FROM "UserSettings";

DROP TABLE "UserSettings";
ALTER TABLE "new_UserSettings" RENAME TO "UserSettings";
CREATE UNIQUE INDEX "UserSettings_userId_key" ON "UserSettings"("userId");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
