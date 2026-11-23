export const questionnaireProfile = {
  version: 45, name: 'questionnaire-profile',
  sql: `
CREATE UNIQUE INDEX questionnaire_progress_attempt
  ON questionnaire_progress(chat_id,generation,user_id,attempt);
CREATE TABLE questionnaire_answer_facts (
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  attempt TEXT NOT NULL,
  template_key TEXT NOT NULL,
  template_revision INTEGER NOT NULL,
  position INTEGER NOT NULL CHECK(position>0),
  question TEXT NOT NULL,
  field_key TEXT NOT NULL,
  fact_id INTEGER NOT NULL UNIQUE REFERENCES profile_facts(id) ON DELETE CASCADE,
  PRIMARY KEY(chat_id,generation,user_id,attempt,position),
  UNIQUE(chat_id,generation,user_id,field_key),
  FOREIGN KEY(chat_id,generation,user_id,attempt)
    REFERENCES questionnaire_progress(chat_id,generation,user_id,attempt) ON DELETE CASCADE
) STRICT;
CREATE TABLE questionnaire_access (
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  user_id TEXT NOT NULL CHECK(user_id<>chat_id),
  attempt TEXT NOT NULL,
  response_message_id INTEGER CHECK(response_message_id BETWEEN 1 AND 9007199254740991),
  prompt_message_id INTEGER CHECK(prompt_message_id BETWEEN 1 AND 9007199254740991),
  prompt_delivered_at INTEGER CHECK(prompt_delivered_at BETWEEN 0 AND 9007199254740991),
  decision TEXT CHECK(decision IN ('open','closed')),
  decision_message_id INTEGER CHECK(decision_message_id BETWEEN 1 AND 9007199254740991),
  CHECK((prompt_message_id IS NULL)=(prompt_delivered_at IS NULL)),
  CHECK((decision IS NULL)=(decision_message_id IS NULL)),
  PRIMARY KEY(chat_id,generation,user_id,attempt),
  UNIQUE(chat_id,generation,prompt_message_id),
  FOREIGN KEY(chat_id,generation,user_id,attempt)
    REFERENCES questionnaire_progress(chat_id,generation,user_id,attempt) ON DELETE CASCADE
) STRICT;

-- Прежняя запись подтверждает завершение, но не доставку вопроса о доступе.
INSERT INTO questionnaire_access(chat_id,generation,user_id,attempt,response_message_id)
SELECT q.chat_id,q.generation,q.user_id,q.attempt,
  CASE WHEN m.platform_message_id=printf('%lld',CAST(m.platform_message_id AS INTEGER))
    AND CAST(m.platform_message_id AS INTEGER) BETWEEN 1 AND 9007199254740991
    THEN CAST(m.platform_message_id AS INTEGER) ELSE q.shown_message_id END
FROM questionnaire_progress q LEFT JOIN messages m
  ON m.id=q.source_id AND m.chat_id=q.chat_id AND m.user_id=q.user_id
WHERE q.state='completed' AND q.chat_id<>q.user_id;

CREATE TEMP TABLE questionnaire_profile_backfill AS
SELECT q.chat_id,q.generation,q.user_id,q.attempt,m.platform_message_id,m.timestamp,
  json_extract(q.template,'$.ref.key') AS template_key,
  json_extract(q.template,'$.ref.revision') AS template_revision,
  json_extract(question.value,'$.position') AS position,
  json_extract(question.value,'$.text') AS question,
  'questionnaire:' || json_array(json_extract(q.template,'$.ref.key'),
    json_extract(q.template,'$.ref.revision'),json_extract(question.value,'$.position')) AS field_key,
  answer.value
FROM questionnaire_progress q JOIN chats c ON c.chat_id=q.chat_id AND c.enabled=1
JOIN chat_connections g ON (g.chat_id,g.generation)=(q.chat_id,q.generation) AND g.state='active'
JOIN questionnaire_inputs i ON (i.chat_id,i.generation,i.attempt,i.message_id)=
  (q.chat_id,q.generation,q.attempt,q.source_id)
JOIN personal_visible_messages m ON m.id=i.message_id AND m.chat_id=q.chat_id AND m.user_id=q.user_id
LEFT JOIN chat_participants p ON (p.chat_id,p.user_id)=(q.chat_id,q.user_id)
LEFT JOIN participant_departures d ON (d.chat_id,d.generation,d.user_id)=(q.chat_id,q.generation,q.user_id)
LEFT JOIN history_retention_boundaries b ON (b.chat_id,b.generation)=(q.chat_id,q.generation)
JOIN json_each(q.template,'$.questions') question
JOIN json_each(q.answers) answer ON answer.key=CAST(json_extract(question.value,'$.position') AS TEXT)
WHERE q.state='completed' AND m.role='user' AND m.purpose='conversation' AND m.sender_bot IS NOT 1
  AND coalesce(p.status,'unknown') IN ('present','unknown')
  AND (d.user_id IS NULL OR (d.needs_verification=0 AND m.timestamp>d.returned_at))
  AND m.id>coalesce(b.cleared_through,0) AND m.timestamp>coalesce(b.expired_through,-1)
  AND m.timestamp>coalesce((SELECT unixepoch('subsec')*1000-retention_ms FROM history_retention_policy),-1)
  AND answer.type='text' AND length(trim(answer.value))>0 AND instr(m.text,answer.value)>0
  AND json_extract(q.template,'$.ref.chatId')=q.chat_id
  AND json_extract(q.template,'$.ref.generation')=q.generation
  AND EXISTS (
    SELECT 1 FROM disclosure_publications dp JOIN disclosure_versions v USING(version)
    WHERE (dp.chat_id,dp.generation)=(q.chat_id,q.generation) AND dp.state='delivered'
      AND dp.kind IN ('introduction','update') AND v.profile_notice IS NOT NULL
      AND v.required_version=(SELECT required_version FROM disclosure_versions ORDER BY version DESC LIMIT 1)
      AND dp.delivered_at<m.timestamp
  )
  AND NOT EXISTS (SELECT 1 FROM personal_profile_choices x
    WHERE (x.chat_id,x.generation,x.user_id)=(q.chat_id,q.generation,q.user_id))
  AND NOT EXISTS (SELECT 1 FROM personal_deletions x
    WHERE (x.chat_id,x.generation,x.user_id)=(q.chat_id,q.generation,q.user_id) AND x.confirmed_at IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM profile_facts x
    WHERE (x.chat_id,x.user_id)=(q.chat_id,q.user_id)
      AND x.field_key='questionnaire:' || json_array(json_extract(q.template,'$.ref.key'),
        json_extract(q.template,'$.ref.revision'),json_extract(question.value,'$.position')));
INSERT OR IGNORE INTO chat_participants(chat_id,user_id,role,status,last_seen_at)
SELECT chat_id,user_id,'unknown','unknown',timestamp FROM questionnaire_profile_backfill;
INSERT OR IGNORE INTO participant_profiles(chat_id,user_id,created_at,updated_at)
SELECT chat_id,user_id,timestamp,timestamp FROM questionnaire_profile_backfill;
INSERT INTO profile_facts(chat_id,user_id,field_key,value,source_kind,source_user_id,source_message_id,
  reliability,visibility,created_at,updated_at,generation,source_at,event_key)
SELECT chat_id,user_id,field_key,value,'self',user_id,platform_message_id,'confirmed',
  CASE WHEN chat_id=user_id THEN 'bot' ELSE 'chat' END,timestamp,timestamp,generation,timestamp,
  'questionnaire:' || attempt
FROM questionnaire_profile_backfill ORDER BY chat_id,generation,user_id,position;
INSERT INTO questionnaire_answer_facts
SELECT b.chat_id,b.generation,b.user_id,b.attempt,b.template_key,b.template_revision,b.position,
  b.question,b.field_key,f.id
FROM questionnaire_profile_backfill b JOIN profile_facts f
  ON (f.chat_id,f.generation,f.user_id,f.field_key)=(b.chat_id,b.generation,b.user_id,b.field_key)
  AND f.event_key='questionnaire:' || b.attempt;
UPDATE participant_profiles AS p SET updated_at=max(p.updated_at,(
  SELECT max(b.timestamp) FROM questionnaire_profile_backfill b
  WHERE (b.chat_id,b.user_id)=(p.chat_id,p.user_id)))
WHERE EXISTS (SELECT 1 FROM questionnaire_profile_backfill b WHERE (b.chat_id,b.user_id)=(p.chat_id,p.user_id));
UPDATE questionnaire_progress AS q SET answers=(
  SELECT json_group_object(a.key,a.value) FROM json_each(q.answers) a
  WHERE NOT EXISTS (SELECT 1 FROM questionnaire_answer_facts f
    WHERE (f.chat_id,f.generation,f.user_id,f.attempt)=(q.chat_id,q.generation,q.user_id,q.attempt)
      AND CAST(f.position AS TEXT)=a.key))
WHERE EXISTS (SELECT 1 FROM questionnaire_answer_facts f
  WHERE (f.chat_id,f.generation,f.user_id,f.attempt)=(q.chat_id,q.generation,q.user_id,q.attempt));
DROP TABLE questionnaire_profile_backfill;
`,
} as const;
