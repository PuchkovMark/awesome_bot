export const groupReplyGate = {
  version: 63, name: 'group-reply-gate',
  sql: `
CREATE TABLE group_reply_assessments (
  message_id INTEGER PRIMARY KEY,
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('name','initiative')),
  mode TEXT NOT NULL CHECK(mode IN ('normal','active') AND (kind='name' OR mode='active')),
  received_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at>received_at),
  revision INTEGER NOT NULL CHECK(revision>=0),
  control_revision INTEGER NOT NULL CHECK(control_revision>=0),
  disclosure_version INTEGER NOT NULL CHECK(disclosure_version>0),
  glossary_revision INTEGER CHECK(glossary_revision>0),
  reply_author_id TEXT,
  other_address INTEGER NOT NULL CHECK(other_address IN (0,1)),
  forwarded INTEGER NOT NULL CHECK(forwarded IN (0,1)),
  state TEXT NOT NULL CHECK(state IN ('waiting','reserved','sent','approved','queued','finished')),
  resume_allowed INTEGER NOT NULL DEFAULT 0 CHECK(resume_allowed IN (0,1)),
  attempt_key TEXT,
  source_ids TEXT CHECK(json_valid(source_ids) AND json_type(source_ids)='array'),
  frontier INTEGER CHECK(frontier>0),
  outcome TEXT CHECK(outcome IN ('answer','silence','failed','cancelled','expired','uncertain')),
  latency_ms INTEGER CHECK(latency_ms>=0),
  UNIQUE(chat_id,generation,attempt_key),
  FOREIGN KEY(message_id,chat_id) REFERENCES messages(id,chat_id) ON DELETE CASCADE,
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
CREATE INDEX group_reply_waiting ON group_reply_assessments(state,received_at,message_id);
CREATE INDEX group_reply_scope ON group_reply_assessments(chat_id,generation,state,expires_at);
ALTER TABLE queue_jobs ADD COLUMN group_reply_assessment TEXT CHECK(group_reply_assessment IN ('name','initiative'));

DELETE FROM autonomous_questions;
UPDATE queue_jobs SET state='terminal',outcome='interrupted',owner=NULL
  WHERE initiative_cause IS NOT NULL AND state IN ('queued','running');

ALTER TABLE token_budget_attempts RENAME TO previous_token_budget_attempts;
CREATE TABLE token_budget_attempts (
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  attempt_key TEXT NOT NULL,
  admitted_at INTEGER NOT NULL CHECK(admitted_at BETWEEN 0 AND 9007199254740991),
  purpose TEXT NOT NULL CHECK(purpose IN ('direct','initiative','profile_update','summary','gate_name','gate_initiative')),
  input_reserve INTEGER NOT NULL CHECK(input_reserve BETWEEN 0 AND 9007199254740991),
  output_reserve INTEGER NOT NULL CHECK(output_reserve BETWEEN 0 AND 9007199254740991),
  input_tokens INTEGER CHECK(input_tokens BETWEEN 0 AND 9007199254740991),
  output_tokens INTEGER CHECK(output_tokens BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY(chat_id,generation,attempt_key),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
INSERT INTO token_budget_attempts SELECT * FROM previous_token_budget_attempts;
DROP TABLE previous_token_budget_attempts;
CREATE INDEX token_budget_by_chat ON token_budget_attempts(chat_id,generation,admitted_at);
CREATE INDEX token_budget_expiry ON token_budget_attempts(admitted_at);

ALTER TABLE chat_metrics_buckets RENAME TO previous_chat_metrics_buckets;
CREATE TABLE chat_metrics_buckets (
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  grain TEXT NOT NULL CHECK(grain IN ('hour','day')),
  bucket_at INTEGER NOT NULL,
  series TEXT NOT NULL CHECK(series IN ('requests','main','subagent','initiative_main','initiative_subagent','summary','profile_update','gate_name','gate_initiative')),
  requests INTEGER NOT NULL DEFAULT 0,
  quota_denied INTEGER NOT NULL DEFAULT 0,
  queue_full INTEGER NOT NULL DEFAULT 0,
  flood_denied INTEGER NOT NULL DEFAULT 0,
  expired INTEGER NOT NULL DEFAULT 0,
  interrupted INTEGER NOT NULL DEFAULT 0,
  wait_ms INTEGER NOT NULL DEFAULT 0,
  wait_count INTEGER NOT NULL DEFAULT 0,
  process_ms INTEGER NOT NULL DEFAULT 0,
  process_count INTEGER NOT NULL DEFAULT 0,
  delivered INTEGER NOT NULL DEFAULT 0,
  partial INTEGER NOT NULL DEFAULT 0,
  unknown_delivery INTEGER NOT NULL DEFAULT 0,
  delivery_failed INTEGER NOT NULL DEFAULT 0,
  steps INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  tools INTEGER NOT NULL DEFAULT 0,
  branches_started INTEGER NOT NULL DEFAULT 0,
  branches_finished INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  unknown_input INTEGER NOT NULL DEFAULT 0,
  unknown_output INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(chat_id,generation,grain,bucket_at,series),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_metrics_collection(chat_id,generation) ON DELETE CASCADE
) STRICT;
INSERT INTO chat_metrics_buckets SELECT * FROM previous_chat_metrics_buckets;
DROP TABLE previous_chat_metrics_buckets;
CREATE INDEX chat_metrics_bucket_expiry ON chat_metrics_buckets(grain,bucket_at);

ALTER TABLE chat_metrics_attempts RENAME TO previous_chat_metrics_attempts;
CREATE TABLE chat_metrics_attempts (
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  attempt_key TEXT NOT NULL,
  admitted_at INTEGER NOT NULL,
  series TEXT NOT NULL CHECK(series IN ('main','subagent','initiative_main','initiative_subagent','summary','profile_update','gate_name','gate_initiative')),
  input_tokens INTEGER,
  output_tokens INTEGER,
  failed INTEGER NOT NULL DEFAULT 0 CHECK(failed IN (0,1)),
  PRIMARY KEY(chat_id,generation,attempt_key),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_metrics_collection(chat_id,generation) ON DELETE CASCADE
) STRICT;
INSERT INTO chat_metrics_attempts SELECT * FROM previous_chat_metrics_attempts;
DROP TABLE previous_chat_metrics_attempts;
CREATE INDEX chat_metrics_attempt_expiry ON chat_metrics_attempts(admitted_at);
`,
} as const;
