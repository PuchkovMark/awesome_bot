export const profileInferenceRejections = {
  version: 41, name: 'profile-inference-rejections',
  sql: `
CREATE TABLE profile_inference_rejections (
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  field_key TEXT NOT NULL,
  value_key TEXT NOT NULL,
  rejected_at INTEGER NOT NULL CHECK(rejected_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY(chat_id,generation,user_id,field_key,value_key),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE,
  CHECK((field_key='' AND value_key='') OR (length(field_key)=64 AND length(value_key)=64))
) STRICT;
INSERT INTO profile_inference_rejections
SELECT f.chat_id,f.generation,f.user_id,'','',max(r.rejected_at)
FROM profile_fact_rejections r JOIN profile_facts f ON f.id=r.fact_id
WHERE f.generation IS NOT NULL GROUP BY f.chat_id,f.generation,f.user_id;
`,
} as const;
