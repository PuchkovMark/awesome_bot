export const autonomousReplies = {
  version: 23, name: 'autonomous-replies',
  sql: `
ALTER TABLE chat_controls ADD COLUMN quiet_start INTEGER CHECK(quiet_start BETWEEN 0 AND 1439);
ALTER TABLE chat_controls ADD COLUMN quiet_end INTEGER CHECK(
  (quiet_start IS NULL AND quiet_end IS NULL) OR
  (quiet_start IS NOT NULL AND quiet_end IS NOT NULL AND quiet_end BETWEEN 0 AND 1439 AND quiet_end<>quiet_start)
);
ALTER TABLE messages ADD COLUMN sender_bot INTEGER CHECK(sender_bot IN (0,1));
CREATE INDEX messages_initiative_bots ON messages(chat_id,timestamp) WHERE sender_bot=1;
ALTER TABLE queue_jobs ADD COLUMN initiative_cause TEXT CHECK(initiative_cause IN ('help','free_mention','unanswered'));
ALTER TABLE queue_jobs ADD COLUMN initiative_evidence INTEGER REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE queue_jobs ADD COLUMN initiative_revision INTEGER CHECK(initiative_revision>=0);
ALTER TABLE autonomous_quota_reservations ADD COLUMN reacted_at INTEGER CHECK(
  reacted_at IS NULL OR (first_confirmed_at IS NOT NULL AND reacted_at>=first_confirmed_at)
);
CREATE TABLE autonomous_reply_parts (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  reservation_id INTEGER NOT NULL REFERENCES autonomous_quota_reservations(id) ON DELETE CASCADE
) STRICT;
CREATE INDEX autonomous_parts_reservation ON autonomous_reply_parts(reservation_id);
CREATE TABLE autonomous_questions (
  message_id INTEGER PRIMARY KEY,
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  eligible_at INTEGER NOT NULL CHECK(eligible_at>=0),
  expires_at INTEGER NOT NULL CHECK(expires_at>eligible_at),
  revision INTEGER NOT NULL CHECK(revision>=0),
  control_revision INTEGER NOT NULL CHECK(control_revision>=0),
  disclosure_version INTEGER,
  FOREIGN KEY(message_id,chat_id) REFERENCES messages(id,chat_id) ON DELETE CASCADE,
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
CREATE INDEX autonomous_questions_due ON autonomous_questions(eligible_at,message_id);
`,
} as const;
