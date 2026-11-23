export const personalReminders = {
  version: 24, name: 'personal-reminders',
  sql: `
CREATE TABLE personal_reminder_timezones (
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  timezone TEXT NOT NULL,
  PRIMARY KEY(chat_id,generation),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
CREATE TABLE personal_reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  origin_at INTEGER NOT NULL,
  text TEXT,
  draft TEXT CHECK(draft IS NULL OR json_valid(draft)),
  expires_at INTEGER,
  due_at INTEGER,
  timezone TEXT,
  next_at INTEGER,
  finished_at INTEGER,
  state TEXT NOT NULL CHECK(state IN ('draft','pending','delivered','cancelled','missed','unknown')),
  confirmation TEXT NOT NULL DEFAULT 'pending' CHECK(confirmation IN ('pending','delivered','unknown')),
  lock_token TEXT,
  lock_until INTEGER,
  lock_stage TEXT CHECK(lock_stage IN ('confirmation','delivery')),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE,
  CHECK((state='draft')=(draft IS NOT NULL)),
  CHECK((state IN ('draft','pending'))=(text IS NOT NULL)),
  CHECK((state IN ('draft','pending'))=(finished_at IS NULL)),
  CHECK((state='pending')=(next_at IS NOT NULL)),
  CHECK((lock_token IS NULL)=(lock_until IS NULL) AND (lock_token IS NULL)=(lock_stage IS NULL))
) STRICT;
CREATE INDEX personal_reminders_scope ON personal_reminders(chat_id,generation,id);
CREATE INDEX personal_reminders_due ON personal_reminders(next_at,id) WHERE state='pending';
CREATE INDEX personal_reminders_expiry ON personal_reminders(finished_at) WHERE finished_at IS NOT NULL;
CREATE INDEX personal_reminders_drafts ON personal_reminders(expires_at) WHERE state='draft';
CREATE TABLE personal_reminder_inputs (
  source_chat_id TEXT NOT NULL,
  source_generation INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  target_chat_id TEXT NOT NULL,
  target_generation INTEGER NOT NULL,
  reminder_id INTEGER NOT NULL,
  PRIMARY KEY(source_chat_id,source_generation,event_id),
  FOREIGN KEY(source_chat_id,source_generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE,
  FOREIGN KEY(target_chat_id,target_generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
CREATE INDEX personal_reminder_inputs_target ON personal_reminder_inputs(target_chat_id,target_generation);
CREATE TABLE personal_reminder_parts (
  reminder_id INTEGER NOT NULL REFERENCES personal_reminders(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK(stage IN ('confirmation','delivery')),
  part INTEGER NOT NULL CHECK(part>=0),
  send_id INTEGER NOT NULL UNIQUE CHECK(send_id BETWEEN 1 AND 2147483647),
  text TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'ready' CHECK(state IN ('ready','sending','confirmed','unknown')),
  attempted_at INTEGER,
  receipt TEXT,
  PRIMARY KEY(reminder_id,stage,part)
) STRICT;
`,
} as const;
