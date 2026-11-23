export const addressPreferences = {
  version: 27, name: 'address-preferences',
  sql: `
CREATE TABLE address_preferences (
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  form TEXT CHECK(form IS NULL OR length(form)>0),
  form_message_id INTEGER CHECK(form_message_id BETWEEN 1 AND 9007199254740991),
  visibility TEXT NOT NULL CHECK(visibility IN ('chat','bot','unknown')),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  changed_message_id INTEGER NOT NULL CHECK(changed_message_id BETWEEN 1 AND 9007199254740991),
  changed_at INTEGER NOT NULL CHECK(changed_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY(chat_id,generation,user_id),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE,
  CHECK((form IS NULL)=(form_message_id IS NULL)),
  CHECK(form_message_id IS NULL OR form_message_id<=changed_message_id)
) STRICT;
`,
} as const;
