ALTER TABLE "ChatSettings" ADD COLUMN "welcomeEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ChatSettings" ADD COLUMN "welcomeText" TEXT NOT NULL DEFAULT 'Добро пожаловать, {name}! Рады видеть тебя в беседе.';
ALTER TABLE "ChatSettings" ADD COLUMN "questionnaireEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ChatSettings" ADD COLUMN "questionnaireQuestions" TEXT NOT NULL DEFAULT '["Как к тебе обращаться?","Чем ты увлекаешься?","О чём тебе интересно общаться?"]';

CREATE TABLE "ConversationMember" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "vkUserId" TEXT NOT NULL,
    "isPresent" BOOLEAN NOT NULL DEFAULT false,
    "firstJoinedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastJoinedAt" DATETIME,
    "leftAt" DATETIME,
    "profile" TEXT NOT NULL DEFAULT '{}',
    "questionnaireQuestions" TEXT,
    "questionnaireAnswers" TEXT,
    "questionnaireIndex" INTEGER,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ConversationMember_conversationId_fkey"
      FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ConversationMember_conversationId_vkUserId_key"
  ON "ConversationMember"("conversationId", "vkUserId");
CREATE INDEX "ConversationMember_conversationId_isPresent_idx"
  ON "ConversationMember"("conversationId", "isPresent");
