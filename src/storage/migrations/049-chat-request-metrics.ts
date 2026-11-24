export const chatRequestMetrics = {
  version: 49,
  name: 'chat-request-metrics',
  sql: `
CREATE TABLE chat_metrics_collection (
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  started_at INTEGER NOT NULL CHECK(started_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY(chat_id,generation),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
INSERT INTO chat_metrics_collection(chat_id,generation,started_at)
 SELECT chat_id,generation,CAST(round(unixepoch('subsec')*1000) AS INTEGER) FROM chat_connections;

CREATE TABLE chat_metrics_buckets (
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  grain TEXT NOT NULL CHECK(grain IN ('hour','day')),
  bucket_at INTEGER NOT NULL,
  series TEXT NOT NULL CHECK(series IN ('requests','main','subagent','initiative_main','initiative_subagent','summary','profile_update')),
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
CREATE INDEX chat_metrics_bucket_expiry ON chat_metrics_buckets(grain,bucket_at);

CREATE TABLE chat_metrics_job_events (
  job_id INTEGER NOT NULL REFERENCES queue_jobs(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  PRIMARY KEY(job_id,event_key)
) STRICT, WITHOUT ROWID;

CREATE TABLE chat_metrics_attempts (
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  attempt_key TEXT NOT NULL,
  admitted_at INTEGER NOT NULL,
  series TEXT NOT NULL CHECK(series IN ('main','subagent','initiative_main','initiative_subagent','summary','profile_update')),
  input_tokens INTEGER,
  output_tokens INTEGER,
  failed INTEGER NOT NULL DEFAULT 0 CHECK(failed IN (0,1)),
  PRIMARY KEY(chat_id,generation,attempt_key),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_metrics_collection(chat_id,generation) ON DELETE CASCADE
) STRICT;
CREATE INDEX chat_metrics_attempt_expiry ON chat_metrics_attempts(admitted_at);

CREATE TABLE chat_metrics_publications (
  job_id INTEGER PRIMARY KEY,
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  series TEXT NOT NULL CHECK(series IN ('requests','initiative_main')),
  confirmed INTEGER NOT NULL DEFAULT 0 CHECK(confirmed IN (0,1)),
  finished INTEGER NOT NULL DEFAULT 0 CHECK(finished IN (0,1)),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_metrics_collection(chat_id,generation) ON DELETE CASCADE
) STRICT;
CREATE INDEX chat_metrics_publication_scope ON chat_metrics_publications(chat_id,generation);
CREATE INDEX chat_metrics_publication_expiry ON chat_metrics_publications(received_at);
CREATE INDEX chat_metrics_unfinished_publications ON chat_metrics_publications(job_id) WHERE finished=0;
`,
} as const;
