export const questionnaireInvitations = {
  version: 33, name: 'questionnaire-invitations',
  sql: `
ALTER TABLE chat_controls ADD COLUMN invitation_enabled_at INTEGER
  CHECK(invitation_enabled_at BETWEEN 0 AND 9007199254740991);
ALTER TABLE chat_controls ADD COLUMN invitation_enabled_from INTEGER
  CHECK(invitation_enabled_from BETWEEN 1 AND 9007199254740991);
ALTER TABLE greeting_candidates ADD COLUMN greet INTEGER NOT NULL DEFAULT 1 CHECK(greet IN (0,1));
ALTER TABLE greeting_candidates ADD COLUMN invitation INTEGER NOT NULL DEFAULT 0 CHECK(invitation IN (0,1,2));
ALTER TABLE greeting_members ADD COLUMN greet INTEGER NOT NULL DEFAULT 1 CHECK(greet IN (0,1));
ALTER TABLE greeting_members ADD COLUMN invitation INTEGER NOT NULL DEFAULT 0 CHECK(invitation IN (0,1,2));
ALTER TABLE greeting_members ADD COLUMN invited INTEGER NOT NULL DEFAULT 0 CHECK(invited IN (0,1));
ALTER TABLE greeting_windows ADD COLUMN invitation_state TEXT NOT NULL DEFAULT 'skipped'
  CHECK(invitation_state IN ('waiting','dispatching','delivered','skipped','unknown'));
ALTER TABLE greeting_windows ADD COLUMN invitation_send_id INTEGER
  CHECK(invitation_send_id BETWEEN 1 AND 2147483647);
ALTER TABLE greeting_windows ADD COLUMN invitation_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX questionnaire_invitation_send ON greeting_windows(invitation_send_id)
  WHERE invitation_send_id IS NOT NULL;
CREATE INDEX greeting_open_window ON greeting_windows(chat_id,generation,due_at);
CREATE INDEX questionnaire_invitation_due ON greeting_windows(due_at,id) WHERE invitation_state='waiting';
DROP TRIGGER greeting_disabled_chat;
CREATE TRIGGER greeting_disabled_chat AFTER UPDATE OF enabled,response_mode ON chats
WHEN NEW.enabled=0 OR NEW.response_mode='silent'
BEGIN
  DELETE FROM greeting_candidates WHERE chat_id=NEW.chat_id;
  UPDATE greeting_members SET
    greet=CASE WHEN window_id IN (SELECT id FROM greeting_windows WHERE chat_id=NEW.chat_id AND state='waiting') THEN 0 ELSE greet END,
    invitation=CASE WHEN window_id IN (SELECT id FROM greeting_windows WHERE chat_id=NEW.chat_id AND invitation_state='waiting') THEN 0 ELSE invitation END
  WHERE window_id IN (SELECT id FROM greeting_windows WHERE chat_id=NEW.chat_id AND (state='waiting' OR invitation_state='waiting'));
  UPDATE greeting_windows SET
    state=CASE WHEN state='waiting' THEN 'skipped' ELSE state END,
    invitation_state=CASE WHEN invitation_state='waiting' THEN 'skipped' ELSE invitation_state END
  WHERE chat_id=NEW.chat_id AND (state='waiting' OR invitation_state='waiting');
END;
`,
} as const;
