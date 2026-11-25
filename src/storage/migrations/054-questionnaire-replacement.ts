export const questionnaireReplacement = {
  version: 54, name: 'questionnaire-replacement',
  sql: `
UPDATE questionnaire_editor_prompts SET actor_id=NULL,shown_revision=NULL WHERE actor_id IS NOT NULL;
UPDATE chat_passport_prompts SET actor_id=NULL,action=NULL,revision=NULL,expires_at=NULL
 WHERE section='rules' AND action='edit';
ALTER TABLE questionnaire_editor_prompts ADD COLUMN proposal TEXT;
ALTER TABLE questionnaire_editor_prompts ADD COLUMN editor_message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE;
ALTER TABLE questionnaire_editor_prompts ADD COLUMN proposal_source_id INTEGER REFERENCES messages(id) ON DELETE CASCADE;
CREATE TRIGGER close_questionnaire_proposal AFTER UPDATE OF actor_id ON questionnaire_editor_prompts
WHEN NEW.actor_id IS NULL AND NEW.proposal IS NOT NULL BEGIN
  UPDATE questionnaire_editor_prompts SET proposal=NULL WHERE message_id=NEW.message_id;
END;
`,
} as const;
