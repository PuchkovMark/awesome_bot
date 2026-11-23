export const chatTokenBudget = {
  version: 20, name: 'chat-token-budget',
  sql: `
CREATE TABLE chat_token_budgets (
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  total_limit INTEGER CHECK(total_limit BETWEEN 0 AND 9007199254740991),
  initiative_limit INTEGER CHECK(initiative_limit BETWEEN 0 AND 9007199254740991),
  people INTEGER CHECK(people BETWEEN 0 AND 600479950316),
  observation INTEGER NOT NULL DEFAULT 0 CHECK(observation BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY(chat_id,generation),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;

CREATE TABLE token_budget_attempts (
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  attempt_key TEXT NOT NULL,
  admitted_at INTEGER NOT NULL CHECK(admitted_at BETWEEN 0 AND 9007199254740991),
  purpose TEXT NOT NULL CHECK(purpose IN ('direct','initiative')),
  input_reserve INTEGER NOT NULL CHECK(input_reserve BETWEEN 0 AND 9007199254740991),
  output_reserve INTEGER NOT NULL CHECK(output_reserve BETWEEN 0 AND 9007199254740991),
  input_tokens INTEGER CHECK(input_tokens BETWEEN 0 AND 9007199254740991),
  output_tokens INTEGER CHECK(output_tokens BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY(chat_id,generation,attempt_key),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
CREATE INDEX token_budget_by_chat ON token_budget_attempts(chat_id,generation,admitted_at);
CREATE INDEX token_budget_expiry ON token_budget_attempts(admitted_at);
`,
} as const;
