export const responseTraces={version:12,name:'response-traces',sql:`
CREATE UNIQUE INDEX queue_trace_reference ON queue_jobs(id,chat_id,generation,message_id);
CREATE TABLE response_traces (
 job_id INTEGER PRIMARY KEY, chat_id TEXT NOT NULL, generation INTEGER NOT NULL,
 message_id INTEGER NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER,
 expires_at INTEGER NOT NULL, outcome TEXT CHECK(outcome IN ('completed','failed','rate_limit','interrupted','expired','message_missing','deadline_exceeded')),
 payload TEXT NOT NULL CHECK(json_valid(payload)),
 CHECK(started_at>=0 AND expires_at>started_at),
 CHECK((finished_at IS NULL AND outcome IS NULL) OR (finished_at>=started_at AND outcome IS NOT NULL)),
 UNIQUE(job_id,generation),
 FOREIGN KEY(job_id,chat_id,generation,message_id) REFERENCES queue_jobs(id,chat_id,generation,message_id) ON DELETE CASCADE,
 FOREIGN KEY(message_id,chat_id) REFERENCES messages(id,chat_id) ON DELETE CASCADE,
 FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
CREATE INDEX response_traces_expiry ON response_traces(expires_at);
CREATE INDEX response_traces_latest ON response_traces(chat_id,generation,job_id DESC);
`} as const;
