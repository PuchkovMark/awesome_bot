// Сверка копии использует те же правила для живой базы прежней версии.
export const legacyPublicQuestionnaireAnswers = `
-- Допуск относится к выбранной на момент обновления версии значения.
WITH candidates AS (
  SELECT f.id,b.attempt,f.visibility,f.change_kind,
    row_number() OVER (
      PARTITION BY b.chat_id,b.generation,b.user_id,b.attempt,b.position
      ORDER BY f.source_at DESC,f.event_key COLLATE BINARY DESC,(f.change_kind='withdraw') DESC,f.id
    ) AS rank,
    coalesce((
      SELECT v.visibility FROM profile_facts v
      WHERE (v.chat_id,v.generation,v.user_id,v.field_key)=(b.chat_id,b.generation,b.user_id,b.field_key)
        AND v.change_kind='visibility' AND v.source_kind='self'
      ORDER BY v.source_at DESC,v.event_key COLLATE BINARY DESC,v.id LIMIT 1
    ),f.visibility) AS effective_visibility
  FROM questionnaire_answer_facts b
  JOIN questionnaire_progress q USING(chat_id,generation,user_id,attempt)
  JOIN chat_connections c ON (c.chat_id,c.generation)=(b.chat_id,b.generation)
  JOIN profile_facts f ON (f.chat_id,f.generation,f.user_id,f.field_key)=(b.chat_id,b.generation,b.user_id,b.field_key)
  WHERE b.chat_id<>b.user_id AND q.state='completed' AND f.source_kind='self'
    AND f.source_user_id=b.user_id AND f.change_kind<>'visibility'
    AND (f.change_kind<>'set' OR f.id>coalesce((SELECT fact_floor FROM connection_source_boundaries WHERE chat_id=b.chat_id),0))
)
SELECT x.id,x.attempt FROM candidates x JOIN profile_facts f ON f.id=x.id
WHERE x.rank=1 AND x.change_kind='set'
  AND x.visibility='chat' AND x.effective_visibility='chat'
  AND f.reliability='confirmed' AND (
    (f.event_key='questionnaire:' || x.attempt AND f.source_message_id IS NOT NULL)
    OR f.event_key GLOB '2:profile:*' OR f.event_key GLOB '2:questionnaire:*'
  )
`;

export const questionnairePublicAnswers = {
  version: 61, name: 'questionnaire-public-answers',
  sql: `
ALTER TABLE profile_facts ADD COLUMN questionnaire_public_attempt TEXT CHECK(
  questionnaire_public_attempt IS NULL OR (
    field_key GLOB 'questionnaire:*' AND chat_id<>user_id AND source_kind='self'
    AND source_user_id=user_id AND change_kind='set' AND visibility='chat'
  )
);
UPDATE profile_facts AS f SET questionnaire_public_attempt=x.attempt
FROM (${legacyPublicQuestionnaireAnswers}) x WHERE x.id=f.id;
`,
} as const;
