export const adminRecovery = {
  version: 15, name: 'admin-recovery',
  sql: `
CREATE TABLE admin_recovery_operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  command_id INTEGER NOT NULL CHECK (command_id > 0),
  result TEXT NOT NULL CHECK (result IN ('granted','existing')),
  created_at INTEGER NOT NULL,
  send_id INTEGER NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'pending_delivery' CHECK (state IN ('pending_delivery','sending','delivered')),
  reason TEXT CHECK (reason IN ('unavailable','unconfirmed','interrupted')),
  attempt INTEGER NOT NULL DEFAULT 0,
  last_retry_command_id INTEGER NOT NULL DEFAULT 0,
  attempted_at INTEGER,
  receipt TEXT,
  UNIQUE (owner_id,command_id),
  FOREIGN KEY (chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
CREATE INDEX admin_recovery_scope ON admin_recovery_operations(chat_id,generation);
CREATE TABLE admin_observations (
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  last_membership_id INTEGER NOT NULL DEFAULT 0,
  opened_at INTEGER,
  invite_id INTEGER,
  invite_actor TEXT,
  invite_at INTEGER,
  invite_revision INTEGER,
  invite_selected INTEGER NOT NULL DEFAULT 0 CHECK (invite_selected IN (0,1)),
  community_admin INTEGER CHECK (community_admin IN (0,1)),
  PRIMARY KEY (chat_id,generation),
  FOREIGN KEY (chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
CREATE TABLE admin_presence (
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  present INTEGER NOT NULL CHECK (present IN (0,1)),
  event_id INTEGER,
  PRIMARY KEY (chat_id,generation,user_id),
  FOREIGN KEY (chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;`,
} as const;
