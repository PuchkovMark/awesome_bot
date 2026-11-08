-- Composite index for the frequent chat-context read pattern
-- (conversationId + role + createdAt) used by memoryService context loaders.
CREATE INDEX "Message_conversationId_role_createdAt_idx" ON "Message"("conversationId", "role", "createdAt");
