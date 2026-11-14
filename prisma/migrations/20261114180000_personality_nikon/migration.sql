-- The retired default must fall back to the built-in default.
UPDATE "AppSetting"
SET "value" = 'chipsik', "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'default_personality'
  AND "value" IN ('joker', 'funny', 'gamer');

-- Move saved selections away from the retired character and aliases.
UPDATE "UserSettings"
SET "personality" = COALESCE(
    (SELECT "value" FROM "AppSetting" WHERE "key" = 'default_personality'),
    'chipsik'
)
WHERE "personality" IN ('joker', 'funny', 'gamer');

UPDATE "ChatSettings"
SET "personality" = COALESCE(
    (SELECT "value" FROM "AppSetting" WHERE "key" = 'default_personality'),
    'chipsik'
)
WHERE "personality" IN ('joker', 'funny', 'gamer');

-- Remove Joker and all dependent rows without relying on cascade behavior.
DELETE FROM "CharacterUserSetting" WHERE "personalityId" = 'joker';
DELETE FROM "PersonalityUsage" WHERE "personalityId" = 'joker';
DELETE FROM "PersonalityProfileVersion" WHERE "personalityId" = 'joker';
DELETE FROM "PersonalityProfile" WHERE "id" = 'joker';
