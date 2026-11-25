export const explicitPassportEditors = {
  version: 56, name: 'explicit-passport-editors',
  sql: `
UPDATE chat_passport_prompts SET actor_id=NULL,action=NULL,revision=NULL,expires_at=NULL
 WHERE section!='rules' AND action='edit';
`,
} as const;
