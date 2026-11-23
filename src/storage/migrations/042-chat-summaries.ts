export const chatSummaries = {
  version: 42, name: 'chat-summaries',
  sql: `
CREATE TABLE chat_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  level TEXT NOT NULL CHECK(level IN ('fragment','day','rolling')),
  timezone TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL CHECK(ends_at>starts_at),
  fingerprint TEXT NOT NULL,
  last_id INTEGER NOT NULL,
  source_count INTEGER NOT NULL,
  text TEXT,
  claim TEXT,
  claimed_until INTEGER NOT NULL DEFAULT 0,
  UNIQUE(chat_id,generation,level,timezone,starts_at,ends_at,fingerprint),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
CREATE TABLE chat_summary_sources (
  summary_id INTEGER NOT NULL REFERENCES chat_summaries(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  PRIMARY KEY(message_id,summary_id)
) STRICT;
CREATE INDEX chat_summary_by_summary ON chat_summary_sources(summary_id,message_id);
CREATE TABLE chat_summary_parts (
  parent INTEGER NOT NULL REFERENCES chat_summaries(id) ON DELETE CASCADE,
  child INTEGER NOT NULL REFERENCES chat_summaries(id) ON DELETE CASCADE,
  PRIMARY KEY(parent,child)
) STRICT;
CREATE TABLE chat_summary_notices (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  delivered INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TRIGGER chat_summary_delete_source BEFORE DELETE ON messages BEGIN
  DELETE FROM chat_summaries WHERE id IN (SELECT summary_id FROM chat_summary_sources WHERE message_id=OLD.id);
END;
CREATE TRIGGER chat_summary_hide_source AFTER INSERT ON personal_hidden_messages BEGIN
  DELETE FROM chat_summaries WHERE id IN (SELECT summary_id FROM chat_summary_sources WHERE message_id=NEW.message_id);
END;
`,
} as const;
