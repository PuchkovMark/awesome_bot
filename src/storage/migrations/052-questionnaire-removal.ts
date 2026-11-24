export const questionnaireRemoval = {
  version: 52, name: 'questionnaire-removal',
  sql: `
ALTER TABLE questionnaire_management_prompts ADD COLUMN action TEXT NOT NULL DEFAULT 'edit' CHECK(action IN ('edit','delete'));
CREATE TABLE questionnaire_removals (
  chat_id TEXT NOT NULL, generation INTEGER NOT NULL, user_id TEXT NOT NULL, attempt TEXT NOT NULL,
  removed_at INTEGER NOT NULL, event_id INTEGER NOT NULL, PRIMARY KEY(chat_id,generation,user_id,attempt),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
`,
} as const;
