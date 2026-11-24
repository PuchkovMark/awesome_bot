export const questionnaireAnswerEdits = {
  version: 51, name: 'questionnaire-answer-edits',
  sql: `
CREATE TABLE questionnaire_management_prompts (
  chat_id TEXT NOT NULL, generation INTEGER NOT NULL, receipt INTEGER NOT NULL CHECK(receipt>0),
  user_id TEXT, attempt TEXT, first_position INTEGER NOT NULL, last_position INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, PRIMARY KEY(chat_id,generation,receipt),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
CREATE INDEX questionnaire_management_subject ON questionnaire_management_prompts(chat_id,generation,user_id,attempt);
CREATE TRIGGER questionnaire_invalidate_prompts AFTER DELETE ON questionnaire_progress BEGIN
  UPDATE questionnaire_management_prompts SET user_id=NULL,attempt=NULL,expires_at=0
  WHERE (chat_id,generation,user_id,attempt)=(OLD.chat_id,OLD.generation,OLD.user_id,OLD.attempt);
END;
`,
} as const;
