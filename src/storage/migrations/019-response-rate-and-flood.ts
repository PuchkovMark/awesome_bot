export const responseRateAndFlood = {
  version: 19, name: 'response-rate-and-flood', sql: `
CREATE TABLE response_rate_clock (
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  observed_at INTEGER NOT NULL CHECK(observed_at >= 0),
  PRIMARY KEY(chat_id,generation),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
CREATE TABLE response_rate_publications (
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  publication_key TEXT NOT NULL,
  started_at INTEGER NOT NULL CHECK(started_at >= 0),
  outcome TEXT NOT NULL CHECK(outcome IN ('open','delivered','unknown')),
  PRIMARY KEY(chat_id,generation,publication_key),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
CREATE INDEX response_rate_by_chat ON response_rate_publications(chat_id,generation,started_at);
CREATE INDEX response_rate_expiry ON response_rate_publications(started_at) WHERE outcome<>'open';

CREATE TABLE mention_flood_state (
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  last_mention_at INTEGER NOT NULL CHECK(last_mention_at >= 0),
  burst_id INTEGER,
  silence_ms INTEGER,
  CHECK((burst_id IS NULL AND silence_ms IS NULL) OR (burst_id > 0 AND silence_ms > 0)),
  PRIMARY KEY(chat_id,generation),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
CREATE TABLE mention_flood_inputs (
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  message_id INTEGER NOT NULL CHECK(message_id > 0),
  received_at INTEGER NOT NULL CHECK(received_at >= 0),
  PRIMARY KEY(chat_id,generation,message_id),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
CREATE INDEX mention_flood_by_chat ON mention_flood_inputs(chat_id,generation,received_at);
CREATE INDEX mention_flood_expiry ON mention_flood_inputs(received_at);
`,
} as const;
