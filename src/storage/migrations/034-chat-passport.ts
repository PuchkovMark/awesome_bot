export const chatPassport = {
  version: 34, name: 'chat-passport',
  sql: `
CREATE TABLE chat_passport_sections (
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  section TEXT NOT NULL CHECK(section IN ('topic','rules','traditions','glossary','events')),
  text TEXT CHECK(text IS NULL OR length(CAST(text AS BLOB)) BETWEEN 1 AND 3000),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY(chat_id,generation,section),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
CREATE TABLE chat_passport_prompts (
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  receipt TEXT NOT NULL,
  message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  section TEXT NOT NULL CHECK(section IN ('topic','rules','traditions','glossary','events')),
  actor_id TEXT,
  action TEXT CHECK(action IN ('edit','clear')),
  revision INTEGER CHECK(revision BETWEEN 0 AND 9007199254740991),
  expires_at INTEGER CHECK(expires_at BETWEEN 0 AND 9007199254740991),
  CHECK((actor_id IS NULL AND action IS NULL AND revision IS NULL AND expires_at IS NULL)
     OR (actor_id IS NOT NULL AND action IS NOT NULL AND revision IS NOT NULL AND expires_at IS NOT NULL)),
  PRIMARY KEY(chat_id,generation,receipt),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
CREATE INDEX chat_passport_prompt_expiry ON chat_passport_prompts(expires_at) WHERE expires_at IS NOT NULL;
`,
} as const;
