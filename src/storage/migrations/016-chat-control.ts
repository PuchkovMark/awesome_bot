export const chatControl = {
  version: 16, name: 'chat-control',
  sql: `
CREATE TABLE chat_controls (
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  response_revision INTEGER NOT NULL DEFAULT 0 CHECK(response_revision BETWEEN 0 AND 9007199254740991),
  paused_until INTEGER,
  next_participant_pause INTEGER,
  autonomous_disabled INTEGER NOT NULL DEFAULT 0 CHECK(autonomous_disabled IN (0,1)),
  PRIMARY KEY(chat_id,generation),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
CREATE TABLE chat_control_commands (
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  message_id INTEGER NOT NULL CHECK(message_id > 0),
  PRIMARY KEY(chat_id,generation,actor_id,message_id),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
ALTER TABLE queue_jobs ADD COLUMN control_revision INTEGER NOT NULL DEFAULT 0 CHECK(control_revision >= 0);`,
} as const;
