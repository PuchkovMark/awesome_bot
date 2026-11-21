export const chatConnectionLifecycle = {
  version: 5, name: 'chat-connection-lifecycle',
  sql: `
CREATE TABLE lifecycle_clock (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  value INTEGER NOT NULL CHECK(value BETWEEN 0 AND 9007199254740991)
) STRICT;
INSERT INTO lifecycle_clock VALUES (1,0);
CREATE TABLE chat_connections (
  chat_id TEXT PRIMARY KEY NOT NULL,
  generation INTEGER NOT NULL UNIQUE CHECK(generation BETWEEN 1 AND 9007199254740991),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991),
  state TEXT NOT NULL CHECK(state IN ('active','uncertain')),
  creator_id TEXT,
  inviter_id TEXT,
  creator_applied INTEGER NOT NULL DEFAULT 0 CHECK(creator_applied IN (0,1)),
  inviter_applied INTEGER NOT NULL DEFAULT 0 CHECK(inviter_applied IN (0,1))
) STRICT;
INSERT INTO chat_connections(chat_id,generation,revision,state)
 SELECT chat_id,ROW_NUMBER() OVER (ORDER BY chat_id),0,'uncertain'
 FROM (SELECT chat_id FROM chats UNION SELECT chat_id FROM messages);
UPDATE lifecycle_clock SET value=(SELECT count(*) FROM chat_connections);`,
} as const;
