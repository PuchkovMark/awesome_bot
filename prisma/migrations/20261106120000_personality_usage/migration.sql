CREATE TABLE "PersonalityUsage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "personalityId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "vkUserId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PersonalityUsage_personalityId_fkey"
      FOREIGN KEY ("personalityId") REFERENCES "PersonalityProfile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "PersonalityUsage_personalityId_createdAt_idx"
  ON "PersonalityUsage"("personalityId", "createdAt");
CREATE INDEX "PersonalityUsage_conversationId_createdAt_idx"
  ON "PersonalityUsage"("conversationId", "createdAt");
