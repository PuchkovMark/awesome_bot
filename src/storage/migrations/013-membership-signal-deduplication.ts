export const membershipSignalDeduplication = {
  version: 13,
  name: 'membership-signal-deduplication',
  sql: `
CREATE TABLE connection_membership_signals (
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  signal_key TEXT NOT NULL CHECK(length(signal_key)>0),
  PRIMARY KEY(chat_id,generation,signal_key),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;`,
} as const;
