export const questionnaireInvitationDelivery = {
  version: 62, name: 'questionnaire-invitation-delivery',
  sql: `
ALTER TABLE greeting_windows ADD COLUMN invitation_template TEXT CHECK(json_valid(invitation_template));
ALTER TABLE greeting_windows ADD COLUMN invitation_disclosure INTEGER;
ALTER TABLE greeting_windows ADD COLUMN invitation_enabled_at INTEGER;
ALTER TABLE greeting_windows ADD COLUMN invitation_enabled_from INTEGER;
ALTER TABLE greeting_members ADD COLUMN invitation_participation INTEGER;
ALTER TABLE greeting_members ADD COLUMN invitation_attempt TEXT;

CREATE TABLE questionnaire_invitation_parts (
  window_id INTEGER NOT NULL REFERENCES greeting_windows(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK(stage IN ('warning','questions')),
  send_id INTEGER NOT NULL UNIQUE CHECK(send_id BETWEEN 1 AND 2147483647),
  text_hash TEXT NOT NULL,
  recipient_count INTEGER NOT NULL CHECK(recipient_count>0),
  state TEXT NOT NULL CHECK(state IN ('sending','delivered','failed','unknown')),
  started_at INTEGER NOT NULL,
  receipt INTEGER CHECK(receipt>0),
  confirmed_at INTEGER,
  next_check_at INTEGER,
  message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  CHECK((state='delivered')=(confirmed_at IS NOT NULL)),
  PRIMARY KEY(window_id,stage)
) STRICT;
CREATE INDEX questionnaire_invitation_receipt ON questionnaire_invitation_parts(receipt) WHERE receipt IS NOT NULL;
CREATE INDEX questionnaire_invitation_confirmations ON questionnaire_invitation_parts(next_check_at) WHERE state='unknown';

CREATE TRIGGER questionnaire_invitation_attempt_removed AFTER DELETE ON questionnaire_progress
WHEN OLD.chat_id<>OLD.user_id
BEGIN
  UPDATE greeting_members SET invitation_attempt=OLD.attempt
  WHERE user_id=OLD.user_id AND invited=1 AND invitation_attempt IS NULL AND window_id IN (
    SELECT id FROM greeting_windows WHERE (chat_id,generation)=(OLD.chat_id,OLD.generation)
      AND invitation_template IS NOT NULL
  );
END;
`,
} as const;
