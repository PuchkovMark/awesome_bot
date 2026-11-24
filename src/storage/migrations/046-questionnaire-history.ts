export const questionnaireHistory = {
  version: 46, name: 'questionnaire-history',
  sql: `
DELETE FROM chat_summaries WHERE id IN (
  SELECT s.summary_id FROM chat_summary_sources s JOIN questionnaire_inputs q USING(message_id)
);
UPDATE messages SET purpose='service_notice' WHERE id IN (SELECT message_id FROM questionnaire_inputs);
`,
} as const;
