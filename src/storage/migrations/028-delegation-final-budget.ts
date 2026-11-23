export const delegationFinalBudget = {
  version: 28, name: 'delegation-final-budget',
  sql: `
ALTER TABLE queue_jobs ADD COLUMN final_budget INTEGER NOT NULL DEFAULT 0
  CHECK(final_budget BETWEEN 0 AND 9007199254740991);
CREATE TRIGGER queue_release_final_budget AFTER UPDATE OF state ON queue_jobs
WHEN NEW.state != 'running' AND NEW.final_budget != 0
BEGIN UPDATE queue_jobs SET final_budget=0 WHERE id=NEW.id; END;
`,
} as const;
