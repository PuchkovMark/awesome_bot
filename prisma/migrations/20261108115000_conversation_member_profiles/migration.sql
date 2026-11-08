ALTER TABLE "ConversationMember" ADD COLUMN "profileCompleted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ConversationMember" ADD COLUMN "profileCreatedAt" DATETIME;
ALTER TABLE "ConversationMember" ADD COLUMN "profileUpdatedAt" DATETIME;
ALTER TABLE "ConversationMember" ADD COLUMN "questionnaireInviteSentAt" DATETIME;
ALTER TABLE "ConversationMember" ADD COLUMN "profileDeleteRequestedAt" DATETIME;

UPDATE "ConversationMember"
SET
    "profileCompleted" = CASE WHEN "profile" != '{}' THEN true ELSE false END,
    "profileCreatedAt" = CASE WHEN "profile" != '{}' THEN "updatedAt" ELSE NULL END,
    "profileUpdatedAt" = CASE WHEN "profile" != '{}' THEN "updatedAt" ELSE NULL END,
    "questionnaireInviteSentAt" = "updatedAt";

UPDATE "ChatSettings"
SET "questionnaireQuestions" = '["Сколько лет?","Как к тебе обращаться? (Имя или позывной?)","Работаешь или учишься?","На кого/кем?","Семейное положение: в поиске своего счастья или уже есть вторая половинка?","Сколько в ВРН?","Где любишь гулять?","Кофе или чай?","Какие хобби?","Есть любимые фильмы?","Скинь пару любимых песен.","Ты за активный отдых или лучше фильмец дома глянуть?","Как относишься к алкоголю?","50/50 на первом свидании норм?","Что ждёшь от этой конфы?","Какой MBTI? Ссылка на тест: https://www.16personalities.com/ru"]'
WHERE "questionnaireQuestions" = '["Как к тебе обращаться?","Чем ты увлекаешься?","О чём тебе интересно общаться?"]';

CREATE INDEX "ConversationMember_conversationId_profileCompleted_profileUpdatedAt_idx"
  ON "ConversationMember"("conversationId", "profileCompleted", "profileUpdatedAt");
