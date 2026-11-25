export const recapClarifications = {
  version: 55, name: 'recap-clarifications',
  sql: `
CREATE TABLE recap_clarifications (
  chat_id TEXT NOT NULL, generation INTEGER NOT NULL, receipt TEXT NOT NULL, user_id TEXT NOT NULL,
  message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  root_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  known_from INTEGER, known_to INTEGER, calendar TEXT CHECK(calendar IS NULL OR json_valid(calendar)),
  PRIMARY KEY(chat_id,generation,receipt),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
ALTER TABLE queue_jobs ADD COLUMN recap_prompt_id INTEGER CHECK(recap_prompt_id>0);
CREATE TRIGGER recap_hide_source AFTER INSERT ON personal_hidden_messages BEGIN
  DELETE FROM recap_clarifications WHERE NEW.message_id IN (message_id,root_id,source_id);
END;
`,
} as const;
