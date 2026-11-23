export const participantRegistry = {
  version: 26, name: 'participant-registry',
  sql: `
CREATE TABLE chat_participants_new (
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  joined_at INTEGER CHECK(joined_at IS NULL OR joined_at BETWEEN 0 AND 9007199254740991),
  role TEXT NOT NULL CHECK(role IN ('member', 'admin', 'unknown')),
  role_observed_at INTEGER CHECK(role_observed_at IS NULL OR role_observed_at BETWEEN 0 AND 9007199254740991),
  status TEXT NOT NULL CHECK(status IN ('present', 'left', 'removed', 'absent', 'unknown')),
  status_observed_at INTEGER CHECK(status_observed_at IS NULL OR status_observed_at BETWEEN 0 AND 9007199254740991),
  last_seen_at INTEGER CHECK(last_seen_at IS NULL OR last_seen_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY(chat_id, user_id),
  FOREIGN KEY(chat_id) REFERENCES chats(chat_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK(instr(chat_id, ':') > 1 AND length(chat_id) > instr(chat_id, ':')),
  CHECK(instr(user_id, ':') > 1 AND length(user_id) > instr(user_id, ':')),
  CHECK(substr(chat_id, 1, instr(chat_id, ':') - 1) = substr(user_id, 1, instr(user_id, ':') - 1))
) STRICT;
CREATE TABLE participant_profiles_new (
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),
  updated_at INTEGER NOT NULL CHECK(updated_at BETWEEN 0 AND 9007199254740991 AND updated_at >= created_at),
  PRIMARY KEY(chat_id, user_id),
  FOREIGN KEY(chat_id, user_id) REFERENCES chat_participants_new(chat_id, user_id) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;
CREATE TABLE profile_facts_new (
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
  FOREIGN KEY(chat_id, user_id) REFERENCES participant_profiles_new(chat_id, user_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK(source_user_id IS NULL OR (
    instr(source_user_id, ':') > 1 AND length(source_user_id) > instr(source_user_id, ':') AND
    substr(chat_id, 1, instr(chat_id, ':') - 1) = substr(source_user_id, 1, instr(source_user_id, ':') - 1)
  )),
  CHECK(source_kind <> 'self' OR source_user_id IS NULL OR source_user_id = user_id)
) STRICT;
INSERT INTO chat_participants_new SELECT * FROM chat_participants;
INSERT INTO participant_profiles_new SELECT * FROM participant_profiles;
INSERT INTO profile_facts_new SELECT * FROM profile_facts;
INSERT INTO sqlite_sequence(name,seq)
  SELECT 'profile_facts_new',seq FROM sqlite_sequence
  WHERE name='profile_facts' AND NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='profile_facts_new');
UPDATE sqlite_sequence
  SET seq=max(seq,coalesce((SELECT seq FROM sqlite_sequence WHERE name='profile_facts'),0))
  WHERE name='profile_facts_new';
DROP TABLE profile_facts;
DROP TABLE participant_profiles;
DROP TABLE chat_participants;
ALTER TABLE chat_participants_new RENAME TO chat_participants;
ALTER TABLE participant_profiles_new RENAME TO participant_profiles;
ALTER TABLE profile_facts_new RENAME TO profile_facts;
CREATE INDEX profile_facts_participant ON profile_facts(chat_id, user_id, id);
CREATE INDEX profile_fact_message_source ON profile_facts(chat_id,source_message_id) WHERE source_kind<>'self';

CREATE TABLE participant_sync (
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 9007199254740991),
  last_attempt_at INTEGER CHECK(last_attempt_at>=0),
  last_attempt_complete INTEGER CHECK(last_attempt_complete IN (0,1)),
  last_complete_started_at INTEGER CHECK(last_complete_started_at>=0),
  last_complete_at INTEGER CHECK(last_complete_at>=last_complete_started_at),
  needs_sync INTEGER NOT NULL DEFAULT 1 CHECK(needs_sync IN (0,1)),
  PRIMARY KEY(chat_id,generation),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
CREATE TABLE participant_events (
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  event_key TEXT NOT NULL CHECK(length(event_key)>0),
  PRIMARY KEY(chat_id,generation,event_key),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
`,
} as const;
