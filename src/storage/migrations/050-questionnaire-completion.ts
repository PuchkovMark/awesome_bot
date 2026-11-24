export const questionnaireCompletion = {
  version: 50, name: 'questionnaire-completion',
  sql: `
ALTER TABLE questionnaire_progress ADD COLUMN response_message_id INTEGER;
ALTER TABLE questionnaire_progress ADD COLUMN legacy_access_prompt_id INTEGER;
UPDATE questionnaire_progress AS q SET (response_message_id,legacy_access_prompt_id)=(
  SELECT a.response_message_id,a.prompt_message_id FROM questionnaire_access a
  WHERE (a.chat_id,a.generation,a.user_id,a.attempt)=(q.chat_id,q.generation,q.user_id,q.attempt)
) WHERE state='completed';
CREATE INDEX questionnaire_legacy_receipts ON questionnaire_progress(chat_id,generation,legacy_access_prompt_id)
  WHERE legacy_access_prompt_id IS NOT NULL;
ALTER TABLE questionnaire_presentations RENAME TO questionnaire_presentations_old;

CREATE TABLE questionnaire_presentations (
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  attempt TEXT NOT NULL,
  prompt_message_id INTEGER CHECK(prompt_message_id BETWEEN 1 AND 9007199254740991),
  event_id INTEGER CHECK(event_id BETWEEN 1 AND 9007199254740991),
  state TEXT NOT NULL DEFAULT 'waiting'
    CHECK(state IN ('waiting','declined','sending','delivered','failed','unknown')),
  confirmed_parts INTEGER NOT NULL DEFAULT 0 CHECK(confirmed_parts>=0),
  CHECK((state='waiting')=(event_id IS NULL)),
  PRIMARY KEY(chat_id,generation,user_id,attempt),
  UNIQUE(chat_id,generation,prompt_message_id),
  FOREIGN KEY(chat_id,generation,user_id,attempt)
    REFERENCES questionnaire_progress(chat_id,generation,user_id,attempt) ON DELETE CASCADE
) STRICT;
INSERT INTO questionnaire_presentations SELECT * FROM questionnaire_presentations_old;
DROP TABLE questionnaire_presentations_old;
DROP TABLE questionnaire_access;
`,
} as const;
