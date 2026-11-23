export const questionnaireProgress = {
  version: 36, name: 'questionnaire-progress',
  sql: `
CREATE TABLE questionnaire_progress (
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  attempt TEXT NOT NULL,
  presentation TEXT NOT NULL,
  template TEXT NOT NULL CHECK(json_valid(template)),
  state TEXT NOT NULL CHECK(state IN ('showing','dispatching','active','paused','processing','completed')),
  shown_at INTEGER,
  source_id INTEGER,
  answers TEXT CHECK(answers IS NULL OR json_valid(answers)),
  PRIMARY KEY(chat_id,generation,user_id),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
CREATE TABLE questionnaire_inputs (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  attempt TEXT NOT NULL,
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
CREATE TRIGGER questionnaire_removed_input AFTER DELETE ON questionnaire_inputs
BEGIN
  UPDATE questionnaire_progress SET state='paused',source_id=NULL
    WHERE chat_id=OLD.chat_id AND generation=OLD.generation AND attempt=OLD.attempt
      AND state='processing' AND source_id=OLD.message_id;
END;
CREATE TRIGGER questionnaire_release_job AFTER UPDATE OF state ON queue_jobs
WHEN NEW.state='terminal' AND NEW.outcome IS NOT 'completed'
BEGIN
  UPDATE questionnaire_progress SET state='active',source_id=NULL
    WHERE chat_id=NEW.chat_id AND generation=NEW.generation AND state='processing' AND source_id=NEW.message_id;
END;
`,
} as const;
