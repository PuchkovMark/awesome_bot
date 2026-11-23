export const chatAuthorLabels = {
  version: 22, name: 'chat-author-labels',
  sql: `
CREATE TABLE chat_author_labels (
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  author_number INTEGER NOT NULL CHECK(author_number BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY(chat_id,generation,user_id),
  UNIQUE(chat_id,generation,author_number),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;

WITH routed_groups AS MATERIALIZED (
  SELECT DISTINCT chat_id,generation FROM queue_jobs WHERE route_group=1
), groups AS MATERIALIZED (
  SELECT chat_id,generation FROM routed_groups
  UNION
  SELECT chat_id,generation FROM chat_connections
  WHERE chat_id='vk:' || CAST(substr(chat_id,4) AS INTEGER)
    AND CAST(substr(chat_id,4) AS INTEGER) BETWEEN 2000000000 AND 9007199254740991
), first_messages AS (
  SELECT g.chat_id,g.generation,m.user_id,min(m.id) AS first_id
  FROM groups g JOIN messages m ON m.chat_id=g.chat_id
  LEFT JOIN history_retention_boundaries b ON b.chat_id=g.chat_id AND b.generation=g.generation
  WHERE m.role='user' AND m.purpose='conversation' AND m.id>coalesce(b.cleared_through,0)
    AND m.timestamp>max(coalesce(b.expired_through,-1),coalesce(
      (SELECT CAST(unixepoch('subsec')*1000 AS INTEGER)-retention_ms
       FROM history_retention_policy WHERE singleton=1),-1
    ))
  GROUP BY g.chat_id,g.generation,m.user_id
)
INSERT INTO chat_author_labels(chat_id,generation,user_id,author_number)
SELECT chat_id,generation,user_id,
  row_number() OVER (PARTITION BY chat_id,generation ORDER BY first_id)
FROM first_messages;
`,
} as const;
