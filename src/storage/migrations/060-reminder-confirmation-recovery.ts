export const reminderConfirmationRecovery = {
  version: 60, name: 'reminder-confirmation-recovery',
  sql: `
ALTER TABLE personal_reminders ADD COLUMN schedule_key TEXT
  CHECK(schedule_key IS NULL OR state='pending');
ALTER TABLE personal_reminders ADD COLUMN hint_claimed INTEGER NOT NULL DEFAULT 0
  CHECK(hint_claimed IN (0,1) AND (hint_claimed=0 OR state='pending'));
ALTER TABLE personal_reminder_parts ADD COLUMN definite_failure INTEGER NOT NULL DEFAULT 0
  CHECK(definite_failure IN (0,1) AND
    (definite_failure=0 OR (stage='confirmation' AND state='ready' AND receipt IS NULL)));
ALTER TABLE personal_reminder_inputs ADD COLUMN repeated_request INTEGER NOT NULL DEFAULT 0
  CHECK(repeated_request IN (0,1));
DROP VIEW verified_reminders;
CREATE VIEW verified_reminders AS SELECT r.* FROM personal_reminders r WHERE NOT EXISTS (
  SELECT 1 FROM personal_reminder_inputs i JOIN connection_source_boundaries b
  ON b.chat_id=i.source_chat_id AND b.generation=i.source_generation
  WHERE i.reminder_id=r.id AND i.repeated_request=0 AND r.id<=b.reminder_floor);
`,
} as const;
