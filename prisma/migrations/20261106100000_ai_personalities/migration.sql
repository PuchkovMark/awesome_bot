ALTER TABLE "ChatSettings" ADD COLUMN "personality" TEXT NOT NULL DEFAULT 'alex';
ALTER TABLE "ChatSettings" ADD COLUMN "personalitySettings" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "ChatSettings" ADD COLUMN "allowPersonalityChange" BOOLEAN NOT NULL DEFAULT false;

UPDATE "UserSettings"
SET "personality" = CASE "personality"
    WHEN 'friendly' THEN 'alex'
    WHEN 'funny' THEN 'joker'
    WHEN 'sarcastic' THEN 'max'
    WHEN 'philosopher' THEN 'socrates'
    WHEN 'consultant' THEN 'victor'
    WHEN 'gamer' THEN 'joker'
    ELSE "personality"
END;

CREATE TABLE "PersonalityProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "example" TEXT NOT NULL,
    "systemPrompt" TEXT NOT NULL,
    "settings" TEXT NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "directEnabled" BOOLEAN NOT NULL DEFAULT true,
    "chatEnabled" BOOLEAN NOT NULL DEFAULT true,
    "allowedUsers" TEXT NOT NULL DEFAULT '[]',
    "allowedChats" TEXT NOT NULL DEFAULT '[]',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "PersonalityProfileVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "personalityId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "example" TEXT NOT NULL,
    "systemPrompt" TEXT NOT NULL,
    "settings" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "changedBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PersonalityProfileVersion_personalityId_fkey"
      FOREIGN KEY ("personalityId") REFERENCES "PersonalityProfile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "CharacterUserSetting" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userSettingsId" TEXT NOT NULL,
    "personalityId" TEXT NOT NULL,
    "settings" TEXT NOT NULL DEFAULT '{}',
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CharacterUserSetting_userSettingsId_fkey"
      FOREIGN KEY ("userSettingsId") REFERENCES "UserSettings" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CharacterUserSetting_personalityId_fkey"
      FOREIGN KEY ("personalityId") REFERENCES "PersonalityProfile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "PersonalityChange" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "changedBy" TEXT NOT NULL,
    "fromId" TEXT,
    "toId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "PersonalityProfileVersion_personalityId_version_key"
  ON "PersonalityProfileVersion"("personalityId", "version");
CREATE INDEX "PersonalityProfileVersion_personalityId_createdAt_idx"
  ON "PersonalityProfileVersion"("personalityId", "createdAt");
CREATE UNIQUE INDEX "CharacterUserSetting_userSettingsId_personalityId_key"
  ON "CharacterUserSetting"("userSettingsId", "personalityId");
CREATE INDEX "PersonalityChange_conversationId_createdAt_idx"
  ON "PersonalityChange"("conversationId", "createdAt");
CREATE INDEX "PersonalityChange_changedBy_createdAt_idx"
  ON "PersonalityChange"("changedBy", "createdAt");
