-- AlterTable
ALTER TABLE "Message" ADD COLUMN "vkMessageId" INTEGER;
ALTER TABLE "Message" ADD COLUMN "conversationMessageId" INTEGER;
ALTER TABLE "Message" ADD COLUMN "sentAt" DATETIME;
ALTER TABLE "Message" ADD COLUMN "fromId" INTEGER;
ALTER TABLE "Message" ADD COLUMN "authorName" TEXT;
ALTER TABLE "Message" ADD COLUMN "replyToVkMessageId" INTEGER;
ALTER TABLE "Message" ADD COLUMN "replyToConversationMessageId" INTEGER;
ALTER TABLE "Message" ADD COLUMN "replyToFromId" INTEGER;
ALTER TABLE "Message" ADD COLUMN "replyToAuthorName" TEXT;
ALTER TABLE "Message" ADD COLUMN "replyToText" TEXT;
ALTER TABLE "Message" ADD COLUMN "attachments" TEXT;

-- Backfill existing rows
UPDATE "Message" SET "sentAt" = "createdAt" WHERE "sentAt" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Message_conversationId_conversationMessageId_key" ON "Message"("conversationId", "conversationMessageId");

-- CreateIndex
CREATE INDEX "Message_conversationId_sentAt_idx" ON "Message"("conversationId", "sentAt");

-- CreateIndex
CREATE INDEX "Message_conversationId_conversationMessageId_idx" ON "Message"("conversationId", "conversationMessageId");

-- CreateIndex
CREATE INDEX "Message_conversationId_replyToConversationMessageId_idx" ON "Message"("conversationId", "replyToConversationMessageId");
