export const profileFactEvents = {
  version: 29, name: 'profile-fact-events',
  sql: `
ALTER TABLE profile_facts ADD COLUMN generation INTEGER
  REFERENCES chat_connections(generation) ON DELETE CASCADE
  CHECK(generation > 0);
ALTER TABLE profile_facts ADD COLUMN source_at INTEGER
  CHECK(source_at BETWEEN 0 AND 9007199254740991);
ALTER TABLE profile_facts ADD COLUMN event_key TEXT CHECK(length(event_key)>0);
ALTER TABLE profile_facts ADD COLUMN interest_key TEXT NOT NULL DEFAULT '';
ALTER TABLE profile_facts ADD COLUMN change_kind TEXT NOT NULL DEFAULT 'set' CHECK(
  (generation IS NULL AND source_at IS NULL AND event_key IS NULL AND interest_key='' AND change_kind='set')
  OR (generation IS NOT NULL AND source_at IS NOT NULL AND event_key IS NOT NULL
    AND ((field_key='interest' AND interest_key<>'') OR (field_key<>'interest' AND interest_key=''))
    AND (change_kind='set' OR (source_kind='self' AND
      (change_kind='visibility' OR (change_kind='withdraw' AND field_key='interest')))))
);
CREATE UNIQUE INDEX profile_fact_event ON profile_facts
  (chat_id,generation,user_id,field_key,interest_key,source_kind,event_key,change_kind)
  WHERE generation IS NOT NULL;
CREATE INDEX profile_fact_interest ON profile_facts (chat_id,generation,interest_key,user_id)
  WHERE field_key='interest' AND generation IS NOT NULL;
`,
} as const;
