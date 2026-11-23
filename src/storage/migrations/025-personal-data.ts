export const personalData = {
  version: 25, name: 'personal-data',
  sql: `
ALTER TABLE chat_connections ADD COLUMN erased_author_number INTEGER NOT NULL DEFAULT 0;
ALTER TABLE disclosure_versions ADD COLUMN profile_notice TEXT;
CREATE TABLE personal_profile_choices (
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  disabled_at INTEGER NOT NULL CHECK(disabled_at>=0),
  purged_at INTEGER CHECK(purged_at>=disabled_at),
  PRIMARY KEY(chat_id,generation,user_id),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
CREATE TABLE personal_retained_denials (
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY(chat_id,generation,user_id),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
CREATE VIEW active_admin_denials AS
  SELECT chat_id,user_id FROM bot_admin_revocations UNION ALL
  SELECT chat_id,user_id FROM personal_retained_denials;
CREATE TABLE personal_exports (
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  event TEXT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0 CHECK(delivered IN (0,1)),
  PRIMARY KEY(chat_id,generation,user_id,event),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
CREATE TABLE personal_deletions (
  code TEXT PRIMARY KEY NOT NULL,
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  request_event TEXT NOT NULL,
  requested_at INTEGER NOT NULL CHECK(requested_at>=0),
  confirmed_at INTEGER CHECK(confirmed_at>=requested_at AND confirmed_at<requested_at+900000),
  cutoff_id INTEGER CHECK(cutoff_id>=0),
  verified_at INTEGER CHECK(verified_at IS NULL OR (confirmed_at IS NOT NULL AND verified_at>=confirmed_at)),
  UNIQUE(chat_id,generation,user_id,request_event),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
CREATE TABLE personal_hidden_messages (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  code TEXT NOT NULL REFERENCES personal_deletions(code) ON DELETE CASCADE,
  disputed INTEGER NOT NULL CHECK(disputed IN (0,1)),
  PRIMARY KEY(message_id,code)
) STRICT;
CREATE TABLE personal_answer_sources (
  answer_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  PRIMARY KEY(source_id,answer_id)
) STRICT;
CREATE VIEW personal_visible_messages AS SELECT * FROM messages WHERE id NOT IN (SELECT message_id FROM personal_hidden_messages);
`,
} as const;
