export const pausedResetRequests = {
  version: 53, name: 'paused-reset-requests',
  sql: `
CREATE TABLE paused_reset_requests (
  code TEXT PRIMARY KEY, owner_id TEXT NOT NULL, event_id INTEGER NOT NULL, chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL, revision INTEGER NOT NULL, send_id INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','ready','cancelled','confirmed','closed')),
  receipt INTEGER, expires_at INTEGER, UNIQUE(owner_id,event_id)
) STRICT;
CREATE TRIGGER close_paused_resets AFTER DELETE ON chat_connections BEGIN
  UPDATE paused_reset_requests SET state='closed'
  WHERE chat_id=OLD.chat_id AND generation=OLD.generation AND state IN ('pending','ready');
END;
`,
} as const;
