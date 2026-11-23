export const connectionPauseReason = {
  version: 21, name: 'connection-pause-reason',
  sql: `
ALTER TABLE chat_connections ADD COLUMN pause_reason TEXT CHECK(
  pause_reason IS NULL OR (
    state='uncertain' AND pause_reason IN (
      'startup','observation_lost','first_seen','membership_signal','verification_uncertain'
    )
  )
);
`,
} as const;
