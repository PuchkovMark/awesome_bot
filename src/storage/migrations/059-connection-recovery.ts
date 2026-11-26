export const connectionRecovery = {
  version: 59, name: 'connection-recovery',
  sql: `
ALTER TABLE chat_connections ADD COLUMN established INTEGER NOT NULL DEFAULT 0 CHECK(established IN (0,1));
UPDATE chat_connections AS c SET established=1 WHERE state='active' OR (
  (pause_reason IN ('startup','observation_lost','verification_uncertain') OR pause_reason IS NULL) AND (
    EXISTS (SELECT 1 FROM messages m WHERE m.chat_id=c.chat_id AND m.purpose='conversation' AND m.role='user')
    OR EXISTS (SELECT 1 FROM admin_observations a WHERE a.chat_id=c.chat_id AND a.generation=c.generation AND a.opened_at IS NOT NULL)
  ));
CREATE TABLE connection_source_boundaries (
  chat_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, revision INTEGER NOT NULL,
  message_floor INTEGER NOT NULL, fact_floor INTEGER NOT NULL, input_floor INTEGER NOT NULL, reminder_floor INTEGER NOT NULL,
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
CREATE TABLE connection_observations (
  chat_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, input_through INTEGER NOT NULL DEFAULT 0,
  last_departure INTEGER,
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
CREATE TABLE unverified_admin_grants (
  chat_id TEXT NOT NULL, generation INTEGER NOT NULL, user_id TEXT NOT NULL,
  basis TEXT NOT NULL, granted_at INTEGER NOT NULL, granted_by TEXT,
  PRIMARY KEY(chat_id,generation,user_id,basis),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
DROP VIEW personal_visible_messages;
CREATE VIEW personal_visible_messages AS SELECT m.* FROM messages m
  WHERE m.id NOT IN (SELECT message_id FROM personal_hidden_messages)
    AND m.id NOT IN (SELECT answer_id FROM departed_profile_answers)
    AND NOT EXISTS (SELECT 1 FROM connection_source_boundaries b WHERE b.chat_id=m.chat_id AND m.id<=b.message_floor);
CREATE VIEW verified_reminders AS SELECT r.* FROM personal_reminders r WHERE NOT EXISTS (
  SELECT 1 FROM personal_reminder_inputs i JOIN connection_source_boundaries b
  ON b.chat_id=i.source_chat_id AND b.generation=i.source_generation
  WHERE i.reminder_id=r.id AND r.id<=b.reminder_floor);
CREATE INDEX reminder_inputs_by_reminder ON personal_reminder_inputs(reminder_id);
`,
} as const;
