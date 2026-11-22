export const chatHistoryRetention = {
  version: 18, name: 'chat-history-retention',
  sql: `
CREATE TABLE history_retention_policy (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  retention_ms INTEGER NOT NULL CHECK(retention_ms > 0)
) STRICT;
CREATE TABLE history_retention_boundaries (
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  cleared_through INTEGER NOT NULL DEFAULT 0 CHECK(cleared_through >= 0),
  expired_through INTEGER NOT NULL DEFAULT -1 CHECK(expired_through >= -1),
  PRIMARY KEY(chat_id,generation),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
CREATE TABLE history_deleted_inputs (
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  platform_message_id TEXT NOT NULL,
  PRIMARY KEY(chat_id,generation,platform_message_id),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
CREATE TABLE history_clear_requests (
  code TEXT PRIMARY KEY NOT NULL,
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  initiator_id TEXT NOT NULL,
  origin_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  owner_request INTEGER NOT NULL CHECK(owner_request IN (0,1)),
  through_id INTEGER NOT NULL CHECK(through_id >= 0),
  message_count INTEGER NOT NULL CHECK(message_count >= 0),
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','confirmed','invalidated')),
  UNIQUE(chat_id,generation,origin_id,event_id),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
CREATE INDEX history_clear_initiator ON history_clear_requests(chat_id,initiator_id) WHERE state='pending' AND owner_request=0;
CREATE INDEX messages_retention_chat_id ON messages(chat_id,id);
CREATE INDEX messages_retention_time ON messages(timestamp,id);
CREATE INDEX profile_fact_message_source ON profile_facts(chat_id,source_message_id) WHERE source_kind<>'self';
CREATE TRIGGER history_clear_grant_loss AFTER DELETE ON bot_admin_grants
WHEN NOT EXISTS(SELECT 1 FROM bot_admin_grants WHERE chat_id=OLD.chat_id AND user_id=OLD.user_id)
BEGIN
  UPDATE history_clear_requests SET state='invalidated'
  WHERE chat_id=OLD.chat_id AND initiator_id=OLD.user_id AND owner_request=0 AND state='pending';
END;
CREATE TRIGGER history_clear_disabled AFTER UPDATE OF enabled ON chats WHEN OLD.enabled=1 AND NEW.enabled=0
BEGIN
  UPDATE history_clear_requests SET state='invalidated'
  WHERE chat_id=NEW.chat_id AND owner_request=0 AND state='pending';
END;
CREATE TRIGGER history_clear_revocation AFTER INSERT ON bot_admin_revocations BEGIN
  UPDATE history_clear_requests SET state='invalidated'
  WHERE chat_id=NEW.chat_id AND initiator_id=NEW.user_id AND owner_request=0 AND state='pending';
END;`,
} as const;
