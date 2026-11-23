export const questionnaireDelivery = {
  version: 38, name: 'questionnaire-delivery',
  sql: `
ALTER TABLE questionnaire_progress ADD COLUMN warning_delivered INTEGER NOT NULL DEFAULT 0
  CHECK(warning_delivered IN (0,1));
ALTER TABLE questionnaire_progress ADD COLUMN shown_message_id INTEGER
  CHECK(shown_message_id BETWEEN 1 AND 9007199254740991);
`,
} as const;
