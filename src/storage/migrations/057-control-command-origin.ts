export const controlCommandOrigin = {
  version: 57, name: 'control-command-origin',
  sql: `
CREATE TABLE chat_control_commands_with_origin (
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  message_id INTEGER NOT NULL CHECK(message_id > 0),
  source_chat_id TEXT,
  legacy_before INTEGER,
  CHECK (
    (source_chat_id IS NOT NULL AND length(source_chat_id) > 0 AND legacy_before IS NULL)
    OR (source_chat_id IS NULL AND legacy_before IS NOT NULL AND legacy_before BETWEEN 1 AND 9007199254740991)
  ),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
INSERT INTO chat_control_commands_with_origin(chat_id,generation,actor_id,message_id,legacy_before)
SELECT chat_id,generation,actor_id,message_id,(unixepoch() + 1) * 1000 FROM chat_control_commands;
DROP TABLE chat_control_commands;
ALTER TABLE chat_control_commands_with_origin RENAME TO chat_control_commands;
CREATE UNIQUE INDEX control_commands_by_origin
  ON chat_control_commands(chat_id,generation,actor_id,source_chat_id,message_id)
  WHERE source_chat_id IS NOT NULL;
CREATE UNIQUE INDEX legacy_control_commands
  ON chat_control_commands(chat_id,generation,actor_id,message_id)
  WHERE source_chat_id IS NULL;
CREATE INDEX control_commands_by_target
  ON chat_control_commands(chat_id,generation,actor_id);
`,
} as const;
