export const starterPersonas = {
  version: 44,
  name: 'starter-personas',
  sql: `
CREATE TABLE starter_persona_versions (
 persona_id TEXT PRIMARY KEY NOT NULL CHECK(length(persona_id)>0),
 kind TEXT NOT NULL DEFAULT 'persona' CHECK(kind='persona'),
 entity_key TEXT NOT NULL,
 version INTEGER NOT NULL,
 UNIQUE(kind,entity_key,version),
 FOREIGN KEY(kind,entity_key,version) REFERENCES global_content_versions(kind,entity_key,version)
) STRICT;`,
} as const;
