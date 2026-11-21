export const messageRouting = { version: 8, name: 'message-routing', sql: `
ALTER TABLE chats ADD COLUMN response_mode_next TEXT NOT NULL DEFAULT 'normal' CHECK(response_mode_next IN ('silent','normal','active'));
ALTER TABLE chats DROP COLUMN response_mode;
ALTER TABLE chats RENAME COLUMN response_mode_next TO response_mode;
ALTER TABLE messages ADD COLUMN purpose TEXT NOT NULL DEFAULT 'conversation' CHECK(purpose IN ('conversation','service_notice'));
CREATE TABLE notice_periods (
 chat_id TEXT PRIMARY KEY NOT NULL, generation INTEGER NOT NULL,
 next_at INTEGER NOT NULL CHECK(next_at BETWEEN 0 AND 9007199254740991),
 FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
ALTER TABLE queue_jobs ADD COLUMN route_kind TEXT CHECK(route_kind IN ('direct_message','mention','reply','name'));
ALTER TABLE queue_jobs ADD COLUMN route_mode TEXT CHECK(route_mode IN ('normal','active'));
ALTER TABLE queue_jobs ADD COLUMN route_group INTEGER CHECK(route_group IN (0,1));
DROP TRIGGER messages_ai;
DROP TRIGGER messages_ad;
DROP TRIGGER messages_au;
DROP TABLE messages_fts;
CREATE VIEW context_messages AS SELECT id,text FROM messages WHERE purpose='conversation';
CREATE VIRTUAL TABLE messages_fts USING fts5(text,content='context_messages',content_rowid='id');
CREATE TRIGGER messages_ai AFTER INSERT ON messages WHEN new.purpose='conversation' BEGIN
 INSERT INTO messages_fts(rowid,text) VALUES(new.id,new.text);
END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages WHEN old.purpose='conversation' BEGIN
 INSERT INTO messages_fts(messages_fts,rowid,text) VALUES('delete',old.id,old.text);
END;
CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
 INSERT INTO messages_fts(messages_fts,rowid,text) SELECT 'delete',old.id,old.text WHERE old.purpose='conversation';
 INSERT INTO messages_fts(rowid,text) SELECT new.id,new.text WHERE new.purpose='conversation';
END;
INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
` } as const;
