export const chatQueue = { version: 7, name: 'chat-queue', sql: `
CREATE UNIQUE INDEX messages_queue_reference ON messages(id,chat_id);
CREATE TABLE queue_jobs (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 chat_id TEXT NOT NULL, generation INTEGER NOT NULL,
 message_id INTEGER NOT NULL UNIQUE,
 received_at INTEGER NOT NULL CHECK(received_at BETWEEN 0 AND 9007199254740991),
 expires_at INTEGER NOT NULL CHECK(expires_at BETWEEN received_at AND 9007199254740991),
 state TEXT NOT NULL CHECK(state IN ('queued','running','terminal')),
 outcome TEXT CHECK(outcome IN ('completed','failed','rate_limit','interrupted','expired','message_missing','deadline_exceeded')),
 owner TEXT,
 CHECK((state='terminal' AND outcome IS NOT NULL AND owner IS NULL) OR
       (state='queued' AND outcome IS NULL AND owner IS NULL) OR
       (state='running' AND outcome IS NULL AND owner IS NOT NULL)),
 FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE,
 FOREIGN KEY(message_id,chat_id) REFERENCES messages(id,chat_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX queue_pending ON queue_jobs(state,chat_id,id);
CREATE TABLE queue_turns (
 chat_id TEXT PRIMARY KEY NOT NULL, generation INTEGER NOT NULL,
 served INTEGER NOT NULL CHECK(served BETWEEN 0 AND 9007199254740991),
 FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
CREATE TABLE queue_lease (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), token TEXT,
 expires_at INTEGER NOT NULL CHECK(expires_at BETWEEN 0 AND 9007199254740991),
 safety_ms INTEGER NOT NULL CHECK(safety_ms>=0),
 sequence INTEGER NOT NULL CHECK(sequence BETWEEN 0 AND 9007199254740991)
) STRICT;
INSERT INTO queue_lease VALUES(1,NULL,0,0,0);
` } as const;
