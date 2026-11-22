export const chatDisclosure = {
  version: 14, name: 'chat-disclosure',
  sql: `
CREATE TABLE disclosure_versions (
  version INTEGER PRIMARY KEY,
  required_version INTEGER NOT NULL REFERENCES disclosure_versions(version),
  provider TEXT NOT NULL,
  data_policy TEXT NOT NULL,
  storage_policy TEXT NOT NULL,
  details_text TEXT NOT NULL,
  details_url TEXT NOT NULL,
  owner_contact TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE disclosure_publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  version INTEGER NOT NULL REFERENCES disclosure_versions(version),
  kind TEXT NOT NULL CHECK (kind IN ('introduction','owner','update')),
  slot INTEGER NOT NULL CHECK ((kind='update' AND slot BETWEEN 1 AND version) OR (kind<>'update' AND slot=0)),
  state TEXT NOT NULL CHECK (state IN ('pending','sending','unknown','delivered','cancelled')),
  reason TEXT CHECK (reason IN ('rights','owner_closed','unavailable','stale_version','unconfirmed')),
  text TEXT,
  send_id INTEGER UNIQUE,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  replayed INTEGER NOT NULL DEFAULT 0 CHECK (replayed IN (0,1)),
  attempted_at INTEGER,
  receipt TEXT,
  delivered_at INTEGER,
  UNIQUE (generation,kind,slot),
  FOREIGN KEY (chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
CREATE INDEX disclosure_publications_scope ON disclosure_publications(chat_id,generation);
ALTER TABLE queue_jobs ADD COLUMN disclosure_version INTEGER REFERENCES disclosure_versions(version);`,
} as const;
