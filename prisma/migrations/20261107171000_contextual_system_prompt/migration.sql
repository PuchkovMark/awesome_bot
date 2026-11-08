ALTER TABLE "ChatSettings" ADD COLUMN "systemPrompt" TEXT;
DELETE FROM "AppSetting" WHERE "key" = 'system_prompt';
