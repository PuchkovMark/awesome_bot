export const journalAndChats = {
  version: 1, name: 'journal-and-chats',
  sql: `
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  platform_message_id TEXT NOT NULL CHECK(length(platform_message_id) > 0),
  user_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  text TEXT NOT NULL,
  reply_to_message_id TEXT CHECK(reply_to_message_id IS NULL OR length(reply_to_message_id) > 0),
  timestamp INTEGER NOT NULL CHECK(timestamp >= 0 AND timestamp <= 9007199254740991),
  UNIQUE(chat_id, platform_message_id)
) STRICT;
CREATE INDEX messages_chat_time ON messages(chat_id, timestamp, id);
CREATE TABLE chats (
  chat_id TEXT PRIMARY KEY NOT NULL,
  title TEXT,
  system_prompt TEXT,
  response_mode TEXT NOT NULL CHECK(response_mode IN ('always', 'mention')),
  timezone TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
  created_at INTEGER NOT NULL CHECK(created_at >= 0 AND created_at <= 9007199254740991)
) STRICT;`,
} as const;
