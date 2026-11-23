export const profileUpdateQueue = {
  version: 39, name: 'profile-update-queue',
  sql: `
CREATE TABLE profile_update_waiting (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  queued_at INTEGER NOT NULL CHECK(queued_at BETWEEN 0 AND 9007199254740991),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
CREATE INDEX profile_update_queue_order ON profile_update_waiting(chat_id,generation,queued_at,message_id);
CREATE TABLE profile_update_runs (
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  started_at INTEGER NOT NULL CHECK(started_at BETWEEN 0 AND 9007199254740991),
  attempt_key TEXT,
  PRIMARY KEY(chat_id,generation),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
`,
} as const;
