export const botAdministration = {
  version: 4, name: 'bot-administration',
  sql: `
CREATE TABLE bot_admin_grants (
  chat_id TEXT NOT NULL REFERENCES chats(chat_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  user_id TEXT NOT NULL,
  basis TEXT NOT NULL CHECK(basis IN ('creator','inviter','explicit')),
  granted_at INTEGER NOT NULL CHECK(granted_at BETWEEN 0 AND 9007199254740991),
  granted_by TEXT,
  PRIMARY KEY(chat_id,user_id,basis),
  CHECK(instr(chat_id, ':') > 1 AND length(chat_id) > instr(chat_id, ':')),
  CHECK(instr(user_id, ':') > 1 AND length(user_id) > instr(user_id, ':')),
  CHECK(substr(chat_id,1,instr(chat_id,':')-1) = substr(user_id,1,instr(user_id,':')-1)),
  CHECK(granted_by IS NULL OR (instr(granted_by,':') > 1 AND length(granted_by) > instr(granted_by,':')))
) STRICT;
CREATE UNIQUE INDEX bot_admin_protected ON bot_admin_grants(chat_id,basis) WHERE basis <> 'explicit';
CREATE TABLE bot_admin_revocations (
  chat_id TEXT NOT NULL REFERENCES chats(chat_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  user_id TEXT NOT NULL,
  revoked_by TEXT NOT NULL,
  revoked_at INTEGER NOT NULL CHECK(revoked_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY(chat_id,user_id),
  CHECK(instr(chat_id,':') > 1 AND length(chat_id) > instr(chat_id,':')),
  CHECK(instr(user_id,':') > 1 AND length(user_id) > instr(user_id,':')),
  CHECK(substr(chat_id,1,instr(chat_id,':')-1) = substr(user_id,1,instr(user_id,':')-1)),
  CHECK(instr(revoked_by,':') > 1 AND length(revoked_by) > instr(revoked_by,':'))
) STRICT;
CREATE TABLE bot_admin_revocation_audit (
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  had_creator INTEGER NOT NULL CHECK(had_creator IN (0,1)),
  had_inviter INTEGER NOT NULL CHECK(had_inviter IN (0,1)),
  had_explicit INTEGER NOT NULL CHECK(had_explicit IN (0,1)),
  reason TEXT CHECK(reason IS NULL OR length(CAST(reason AS BLOB)) > 0),
  PRIMARY KEY(chat_id,user_id),
  FOREIGN KEY(chat_id,user_id) REFERENCES bot_admin_revocations(chat_id,user_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK(had_creator + had_inviter > 0)
) STRICT;
CREATE TABLE bot_admin_controls (
  chat_id TEXT PRIMARY KEY NOT NULL REFERENCES chats(chat_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  recovery_blocked INTEGER NOT NULL CHECK(recovery_blocked = 1)
) STRICT;`,
} as const;
