-- CreateTable
CREATE TABLE "ImageDailyQuota" (
    "vkUserId" TEXT NOT NULL,
    "utcDay" TEXT NOT NULL,
    "used" INTEGER NOT NULL DEFAULT 0,
    "legacyUsed" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,

    PRIMARY KEY ("vkUserId", "utcDay")
);

-- CreateTable
CREATE TABLE "ImageQuotaAttempt" (
    "operationId" TEXT NOT NULL PRIMARY KEY,
    "vkUserId" TEXT NOT NULL,
    "utcDay" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'reserved',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ImageQuotaAttempt_vkUserId_utcDay_fkey" FOREIGN KEY ("vkUserId", "utcDay") REFERENCES "ImageDailyQuota" ("vkUserId", "utcDay") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ImageQuotaAttempt_vkUserId_utcDay_idx" ON "ImageQuotaAttempt"("vkUserId", "utcDay");
