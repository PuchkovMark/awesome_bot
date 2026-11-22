export const chatLimits = { version: 17, name: 'chat-limits', sql: `
CREATE TABLE request_quota_admissions (
  job_id INTEGER PRIMARY KEY CHECK(job_id > 0),
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  admitted_at INTEGER NOT NULL CHECK(admitted_at >= 0),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
CREATE INDEX request_quota_by_chat ON request_quota_admissions(chat_id,generation,admitted_at);
CREATE INDEX request_quota_by_user ON request_quota_admissions(chat_id,generation,user_id,admitted_at);
CREATE INDEX request_quota_expiry ON request_quota_admissions(admitted_at);

CREATE TABLE autonomous_quota_reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  reserved_at INTEGER NOT NULL CHECK(reserved_at >= 0),
  owner TEXT,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0),
  attempted_at INTEGER CHECK(attempted_at >= reserved_at),
  first_confirmed_at INTEGER CHECK(first_confirmed_at >= reserved_at),
  outcome TEXT CHECK(outcome IN ('delivered','unknown')),
  CHECK((owner IS NOT NULL AND outcome IS NULL) OR (owner IS NULL AND outcome IS NOT NULL)),
  CHECK(outcome IS NULL OR (outcome = 'delivered' AND first_confirmed_at IS NOT NULL) OR
    (outcome = 'unknown' AND attempted_at IS NOT NULL AND first_confirmed_at IS NULL)),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
CREATE UNIQUE INDEX autonomous_quota_open ON autonomous_quota_reservations(chat_id,generation) WHERE owner IS NOT NULL;
CREATE INDEX autonomous_quota_by_chat ON autonomous_quota_reservations(chat_id,generation,reserved_at);
CREATE INDEX autonomous_quota_expiry ON autonomous_quota_reservations(reserved_at) WHERE owner IS NULL;
` } as const;
