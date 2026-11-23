export const participantDepartures = {
  version: 37, name: 'participant-departures',
  sql: `
CREATE TABLE participant_departures (
  chat_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 9007199254740991),
  departed_at INTEGER CHECK(departed_at BETWEEN 0 AND 9007199254740991),
  returned_at INTEGER CHECK(returned_at BETWEEN coalesce(departed_at,0) AND 9007199254740991),
  purged_at INTEGER CHECK(purged_at IS NULL OR (departed_at IS NOT NULL AND purged_at-departed_at>=2592000000)),
  profile_epoch INTEGER NOT NULL DEFAULT 0 CHECK(profile_epoch BETWEEN 0 AND revision),
  needs_verification INTEGER NOT NULL DEFAULT 0 CHECK(needs_verification IN (0,1)),
  PRIMARY KEY(chat_id,generation,user_id),
  FOREIGN KEY(chat_id,generation) REFERENCES chat_connections(chat_id,generation) ON DELETE CASCADE
) STRICT;
CREATE INDEX participant_departures_due ON participant_departures(departed_at)
  WHERE returned_at IS NULL AND purged_at IS NULL AND departed_at IS NOT NULL;

INSERT INTO participant_departures(chat_id,generation,user_id,departed_at)
  SELECT p.chat_id,c.generation,p.user_id,
    CASE WHEN p.status IN ('left','removed') THEN p.status_observed_at END
  FROM chat_participants p JOIN chat_connections c USING(chat_id)
  WHERE p.status IN ('left','removed','absent');
`,
} as const;
