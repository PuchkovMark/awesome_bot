export const profileUpdateBudget = {
  version: 40, name: 'profile-update-budget',
  sql: `
ALTER TABLE token_budget_attempts RENAME TO old_token_budget_attempts;
CREATE TABLE token_budget_attempts (
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  attempt_key TEXT NOT NULL,
  admitted_at INTEGER NOT NULL CHECK(admitted_at BETWEEN 0 AND 9007199254740991),
  purpose TEXT NOT NULL CHECK(purpose IN ('direct','initiative','profile_update')),
  input_reserve INTEGER NOT NULL CHECK(input_reserve BETWEEN 0 AND 9007199254740991),
  output_reserve INTEGER NOT NULL CHECK(output_reserve BETWEEN 0 AND 9007199254740991),
  input_tokens INTEGER CHECK(input_tokens BETWEEN 0 AND 9007199254740991),
  output_tokens INTEGER CHECK(output_tokens BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY(chat_id,generation,attempt_key),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
INSERT INTO token_budget_attempts SELECT * FROM old_token_budget_attempts;
DROP TABLE old_token_budget_attempts;
CREATE INDEX token_budget_by_chat ON token_budget_attempts(chat_id,generation,admitted_at);
CREATE INDEX token_budget_expiry ON token_budget_attempts(admitted_at);
`,
} as const;
