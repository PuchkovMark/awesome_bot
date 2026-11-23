export const memberGreetings = {
  version: 31, name: 'member-greetings',
  sql: `
ALTER TABLE chat_controls ADD COLUMN greeting_enabled_at INTEGER
  CHECK(greeting_enabled_at BETWEEN 0 AND 9007199254740991);
ALTER TABLE chat_controls ADD COLUMN greeting_enabled_from INTEGER
  CHECK(greeting_enabled_from BETWEEN 1 AND 9007199254740991);
CREATE TABLE greeting_candidates (
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  source_at INTEGER NOT NULL CHECK(source_at BETWEEN 0 AND 9007199254740991),
  source_sequence INTEGER CHECK(source_sequence BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY(chat_id,generation,user_id),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
CREATE TABLE greeting_windows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  opened_at INTEGER NOT NULL CHECK(opened_at BETWEEN 0 AND 9007199254710991),
  due_at INTEGER NOT NULL CHECK(due_at=opened_at+30000),
  state TEXT NOT NULL CHECK(state IN ('waiting','dispatching','delivered','skipped','unknown')),
  send_id INTEGER UNIQUE CHECK(send_id BETWEEN 1 AND 2147483647),
  message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
CREATE INDEX greeting_due ON greeting_windows(due_at,id) WHERE state='waiting';
CREATE INDEX greeting_scope ON greeting_windows(chat_id,generation,state,due_at);
CREATE TABLE greeting_members (
  window_id INTEGER NOT NULL REFERENCES greeting_windows(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  confirmed_at INTEGER NOT NULL CHECK(confirmed_at BETWEEN 0 AND 9007199254740991),
  was_returning INTEGER NOT NULL CHECK(was_returning IN (0,1)),
  PRIMARY KEY(window_id,user_id)
) STRICT;
CREATE INDEX greeting_member ON greeting_members(user_id,window_id);
CREATE TRIGGER greeting_disabled_chat AFTER UPDATE OF enabled,response_mode ON chats
WHEN NEW.enabled=0 OR NEW.response_mode='silent'
BEGIN
  DELETE FROM greeting_candidates WHERE chat_id=NEW.chat_id;
  UPDATE greeting_windows SET state='skipped' WHERE chat_id=NEW.chat_id AND state='waiting';
END;
`,
} as const;
