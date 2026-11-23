export const questionnaireTemplate = {
  version: 35, name: 'questionnaire-template',
  sql: `
CREATE TABLE questionnaire_default_boundary (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  generation INTEGER NOT NULL CHECK(generation>=0)
) STRICT;
INSERT INTO questionnaire_default_boundary SELECT singleton,value FROM lifecycle_clock;
CREATE TABLE questionnaire_revisions (
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK(revision BETWEEN 2 AND 9007199254740991),
  questions TEXT NOT NULL CHECK(json_valid(questions) AND json_type(questions)='array' AND json_array_length(questions)>0),
  created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY(chat_id,generation,revision),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
CREATE TABLE questionnaire_editor_prompts (
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  receipt TEXT NOT NULL,
  message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  actor_id TEXT,
  shown_revision INTEGER CHECK(shown_revision BETWEEN 0 AND 9007199254740991),
  CHECK((actor_id IS NULL AND shown_revision IS NULL) OR (actor_id IS NOT NULL AND shown_revision IS NOT NULL)),
  PRIMARY KEY(chat_id,generation,receipt),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
`,
} as const;
