export const versionedContent = {
 version:6,name:'versioned-content',sql:`
CREATE UNIQUE INDEX chat_connections_scope ON chat_connections(chat_id,generation);
CREATE TABLE global_content_versions (
 kind TEXT NOT NULL CHECK(kind IN ('system_prompt','persona','greeting_template')),
 entity_key TEXT NOT NULL CHECK(length(entity_key)>0),
 version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 9007199254740991),
 text TEXT NOT NULL,
 created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),
 PRIMARY KEY(kind,entity_key,version)
) STRICT;
CREATE TABLE local_content_versions (
 chat_id TEXT NOT NULL,generation INTEGER NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('persona','greeting_template')),
 entity_key TEXT NOT NULL CHECK(length(entity_key)>0),
 version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 9007199254740991),
 text TEXT NOT NULL,
 created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),
 PRIMARY KEY(chat_id,generation,kind,entity_key,version),
 FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation)
) STRICT;
CREATE TABLE chat_content_selections (
 chat_id TEXT NOT NULL,generation INTEGER NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('persona','greeting_template')),
 global_key TEXT,global_version INTEGER,local_key TEXT,local_version INTEGER,
 PRIMARY KEY(chat_id,generation,kind),
 CHECK((global_key IS NOT NULL AND global_version IS NOT NULL AND local_key IS NULL AND local_version IS NULL)
    OR (global_key IS NULL AND global_version IS NULL AND local_key IS NOT NULL AND local_version IS NOT NULL)),
 FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation),
 FOREIGN KEY(kind,global_key,global_version) REFERENCES global_content_versions(kind,entity_key,version),
 FOREIGN KEY(chat_id,generation,kind,local_key,local_version) REFERENCES local_content_versions(chat_id,generation,kind,entity_key,version)
) STRICT;
CREATE TABLE global_prompt_selection (
 kind TEXT PRIMARY KEY NOT NULL CHECK(kind='system_prompt'),
 entity_key TEXT NOT NULL,version INTEGER NOT NULL,
 FOREIGN KEY(kind,entity_key,version) REFERENCES global_content_versions(kind,entity_key,version)
) STRICT;`
} as const;
