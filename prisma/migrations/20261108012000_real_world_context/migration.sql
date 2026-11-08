ALTER TABLE "UserSettings" ADD COLUMN "locationName" TEXT;
ALTER TABLE "UserSettings" ADD COLUMN "locationLatitude" REAL;
ALTER TABLE "UserSettings" ADD COLUMN "locationLongitude" REAL;
ALTER TABLE "UserSettings" ADD COLUMN "locationCountry" TEXT;
ALTER TABLE "UserSettings" ADD COLUMN "locationRegion" TEXT;
ALTER TABLE "UserSettings" ADD COLUMN "locationTimeZone" TEXT;
ALTER TABLE "UserSettings" ADD COLUMN "timeZone" TEXT;

ALTER TABLE "ChatSettings" ADD COLUMN "locationName" TEXT;
ALTER TABLE "ChatSettings" ADD COLUMN "locationLatitude" REAL;
ALTER TABLE "ChatSettings" ADD COLUMN "locationLongitude" REAL;
ALTER TABLE "ChatSettings" ADD COLUMN "locationCountry" TEXT;
ALTER TABLE "ChatSettings" ADD COLUMN "locationRegion" TEXT;
ALTER TABLE "ChatSettings" ADD COLUMN "locationTimeZone" TEXT;
ALTER TABLE "ChatSettings" ADD COLUMN "timeZone" TEXT;
