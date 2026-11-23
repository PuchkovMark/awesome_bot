export const profileCommands = {
  version: 32, name: 'profile-commands',
  sql: `
CREATE TABLE profile_command_lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL UNIQUE,
  private_generation INTEGER NOT NULL,
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  opened_at INTEGER NOT NULL CHECK(opened_at BETWEEN 0 AND 9007199168340991),
  FOREIGN KEY(user_id,private_generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE,
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
CREATE INDEX profile_command_expiry ON profile_command_lists(opened_at);
CREATE TABLE profile_command_positions (
  list_id INTEGER NOT NULL REFERENCES profile_command_lists(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK(position>0),
  fact_id INTEGER NOT NULL REFERENCES profile_facts(id) ON DELETE CASCADE,
  restriction_id INTEGER REFERENCES profile_facts(id) ON DELETE CASCADE,
  visibility TEXT NOT NULL CHECK(visibility IN ('chat','bot','unknown')),
  PRIMARY KEY(list_id,position)
) STRICT;
CREATE TABLE profile_command_parts (
  list_id INTEGER NOT NULL REFERENCES profile_command_lists(id) ON DELETE CASCADE,
  part INTEGER NOT NULL CHECK(part>0),
  first_position INTEGER NOT NULL CHECK(first_position>0),
  last_position INTEGER NOT NULL CHECK(last_position>=first_position),
  send_id INTEGER NOT NULL UNIQUE CHECK(send_id BETWEEN 1 AND 2147483647),
  receipt TEXT,
  PRIMARY KEY(list_id,part),
  UNIQUE(list_id,receipt)
) STRICT;
CREATE TABLE profile_command_events (
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY(chat_id,generation,event_id),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
CREATE INDEX profile_command_event_expiry ON profile_command_events(expires_at);
CREATE TABLE profile_fact_rejections (
  fact_id INTEGER PRIMARY KEY REFERENCES profile_facts(id) ON DELETE CASCADE,
  rejected_at INTEGER NOT NULL CHECK(rejected_at BETWEEN 0 AND 9007199254740991)
) STRICT;
`,
} as const;
