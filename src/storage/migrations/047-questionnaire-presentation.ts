export const questionnairePresentation = {
  version: 47, name: 'questionnaire-presentation',
  sql: `
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
    REFERENCES questionnaire_access(chat_id,generation,user_id,attempt) ON DELETE CASCADE
) STRICT;
`,
} as const;
