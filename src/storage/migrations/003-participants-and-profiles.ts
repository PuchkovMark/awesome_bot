export const participantsAndProfiles = {
  version: 3, name: 'participants-and-profiles',
  sql: `
CREATE TABLE chat_participants (
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  joined_at INTEGER CHECK(joined_at IS NULL OR joined_at BETWEEN 0 AND 9007199254740991),
  role TEXT NOT NULL CHECK(role IN ('member', 'admin', 'unknown')),
  role_observed_at INTEGER CHECK(role_observed_at IS NULL OR role_observed_at BETWEEN 0 AND 9007199254740991),
  status TEXT NOT NULL CHECK(status IN ('present', 'left', 'removed', 'unknown')),
  status_observed_at INTEGER CHECK(status_observed_at IS NULL OR status_observed_at BETWEEN 0 AND 9007199254740991),
  last_seen_at INTEGER CHECK(last_seen_at IS NULL OR last_seen_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY(chat_id, user_id),
  FOREIGN KEY(chat_id) REFERENCES chats(chat_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK(instr(chat_id, ':') > 1 AND length(chat_id) > instr(chat_id, ':')),
  CHECK(instr(user_id, ':') > 1 AND length(user_id) > instr(user_id, ':')),
  CHECK(substr(chat_id, 1, instr(chat_id, ':') - 1) = substr(user_id, 1, instr(user_id, ':') - 1))
) STRICT;
CREATE TABLE participant_profiles (
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),
  updated_at INTEGER NOT NULL CHECK(updated_at BETWEEN 0 AND 9007199254740991 AND updated_at >= created_at),
  PRIMARY KEY(chat_id, user_id),
  FOREIGN KEY(chat_id, user_id) REFERENCES chat_participants(chat_id, user_id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;
CREATE TABLE profile_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  field_key TEXT NOT NULL CHECK(length(field_key) > 0),
  value TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('self', 'inferred', 'admin')),
  source_user_id TEXT,
  source_message_id TEXT CHECK(source_message_id IS NULL OR length(source_message_id) > 0),
  source_note TEXT,
  reliability TEXT NOT NULL CHECK(reliability IN ('unknown', 'unverified', 'confirmed')),
  visibility TEXT NOT NULL CHECK(visibility IN ('unknown', 'bot', 'chat')),
  created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),
  updated_at INTEGER NOT NULL CHECK(updated_at BETWEEN 0 AND 9007199254740991 AND updated_at >= created_at),
  FOREIGN KEY(chat_id, user_id) REFERENCES participant_profiles(chat_id, user_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK(source_user_id IS NULL OR (
    instr(source_user_id, ':') > 1 AND length(source_user_id) > instr(source_user_id, ':') AND
    substr(chat_id, 1, instr(chat_id, ':') - 1) = substr(source_user_id, 1, instr(source_user_id, ':') - 1)
  )),
  CHECK(source_kind <> 'self' OR source_user_id IS NULL OR source_user_id = user_id)
) STRICT;
CREATE INDEX profile_facts_participant ON profile_facts(chat_id, user_id, id);`,
} as const;
