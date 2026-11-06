ALTER TABLE "ChatSettings" ADD COLUMN "funAutoReactions" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ChatSettings" ADD COLUMN "funAutoReactionAt" DATETIME;
ALTER TABLE "ChatSettings" ADD COLUMN "funAutoIntervalSeconds" INTEGER NOT NULL DEFAULT 300;
ALTER TABLE "ChatSettings" ADD COLUMN "funAutoProbability" INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "ChatSettings" ADD COLUMN "funSettings" TEXT NOT NULL DEFAULT '{}';

CREATE TABLE "FunPreference" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "vkUserId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "settings" TEXT NOT NULL DEFAULT '{}',
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "FunPreference_vkUserId_conversationId_key" UNIQUE ("vkUserId", "conversationId")
);
CREATE INDEX "FunPreference_conversationId_updatedAt_idx"
  ON "FunPreference"("conversationId", "updatedAt");

CREATE TABLE "FunOutput" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "conversationId" TEXT NOT NULL,
  "vkUserId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FunOutput_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "FunOutput_conversationId_kind_createdAt_idx"
  ON "FunOutput"("conversationId", "kind", "createdAt");

CREATE TABLE "FunFeedback" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "outputId" TEXT NOT NULL,
  "vkUserId" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FunFeedback_outputId_fkey"
    FOREIGN KEY ("outputId") REFERENCES "FunOutput"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FunFeedback_outputId_vkUserId_key" UNIQUE ("outputId", "vkUserId")
);
CREATE INDEX "FunFeedback_outputId_value_idx" ON "FunFeedback"("outputId", "value");
