export const personalDisputes = {
  version: 58, name: 'personal-disputes',
  sql: `
CREATE TABLE personal_dispute_reports (
  source_chat_id TEXT NOT NULL,
  source_message_id INTEGER NOT NULL CHECK(source_message_id > 0),
  code TEXT NOT NULL REFERENCES personal_deletions(code) ON DELETE CASCADE,
  platform_message_id TEXT NOT NULL,
  PRIMARY KEY(source_chat_id,source_message_id)
) STRICT;
CREATE INDEX personal_dispute_reports_by_code ON personal_dispute_reports(code);
CREATE TABLE personal_dispute_cases (
  code TEXT NOT NULL REFERENCES personal_deletions(code) ON DELETE CASCADE,
  platform_message_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('legacy_open','open','keep','erase')),
  PRIMARY KEY(code,platform_message_id)
) STRICT;
INSERT INTO personal_dispute_cases(code,platform_message_id,state)
SELECT h.code,m.platform_message_id,'legacy_open' FROM personal_hidden_messages h
JOIN messages m ON m.id=h.message_id JOIN personal_deletions d ON d.code=h.code AND d.chat_id=m.chat_id
WHERE h.disputed=1 AND d.confirmed_at IS NOT NULL;
CREATE TRIGGER personal_dispute_keep BEFORE INSERT ON personal_hidden_messages
WHEN NEW.disputed=1 AND EXISTS (
  SELECT 1 FROM messages m JOIN personal_dispute_cases c ON c.platform_message_id=m.platform_message_id
  WHERE m.id=NEW.message_id AND c.code=NEW.code AND c.state='keep'
) BEGIN SELECT RAISE(IGNORE); END;
`,
} as const;
