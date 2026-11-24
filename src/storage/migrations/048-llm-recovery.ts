export const llmRecovery = {
  version: 48, name: 'llm-recovery',
  sql: `
CREATE TABLE llm_recovery (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  paused_until INTEGER CHECK(paused_until BETWEEN 0 AND 8640000000000000),
  delay_ms INTEGER NOT NULL CHECK(delay_ms BETWEEN 0 AND 9007199254740991),
  server_errors TEXT NOT NULL CHECK(json_type(server_errors)='array'),
  epoch INTEGER NOT NULL CHECK(epoch BETWEEN 0 AND 9007199254740991),
  probe_owner TEXT,
  CHECK((paused_until IS NULL AND delay_ms=0 AND probe_owner IS NULL) OR
        (paused_until IS NOT NULL AND delay_ms>0))
) STRICT;
INSERT INTO llm_recovery VALUES(1,NULL,0,'[]',0,NULL);
`,
} as const;
