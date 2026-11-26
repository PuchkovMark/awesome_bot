export const reminderConfirmationRecovery = {
  version: 59, name: 'reminder-confirmation-recovery',
  sql: `
ALTER TABLE personal_reminders ADD COLUMN schedule_key TEXT
  CHECK(schedule_key IS NULL OR state='pending');
ALTER TABLE personal_reminders ADD COLUMN hint_claimed INTEGER NOT NULL DEFAULT 0
  CHECK(hint_claimed IN (0,1) AND (hint_claimed=0 OR state='pending'));
ALTER TABLE personal_reminder_parts ADD COLUMN definite_failure INTEGER NOT NULL DEFAULT 0
  CHECK(definite_failure IN (0,1) AND
    (definite_failure=0 OR (stage='confirmation' AND state='ready' AND receipt IS NULL)));
`,
} as const;
