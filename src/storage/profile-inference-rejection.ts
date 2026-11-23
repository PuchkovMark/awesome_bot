import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { ConnectionScope, UserId } from '../contracts/index';
import { inferenceField, inferenceValue, verifiedInference } from './profile-inference-evidence';

function fingerprint(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

const subject = 'chat_id=? AND generation=? AND user_id=?';

export function rememberInferenceRejection(
  db: Database,
  scope: ConnectionScope,
  user: UserId,
  fact: { readonly fieldKey: string; readonly value: string },
  now: number,
) {
  const field = inferenceField(fact.fieldKey);
  const value = inferenceValue(field, fact.value);
  db.prepare(
    `INSERT INTO profile_inference_rejections VALUES(?,?,?,?,?,?)
    ON CONFLICT(chat_id,generation,user_id,field_key,value_key) DO UPDATE SET
      rejected_at=max(rejected_at,excluded.rejected_at)`,
  ).run(scope.chatId, scope.generation, user, fingerprint(field), fingerprint(value), now);
  // Все уже сохранённые варианты того же утверждения получают отметку до очистки источников.
  const mark = db.prepare(
    'INSERT INTO profile_fact_rejections VALUES(?,?) ON CONFLICT(fact_id) DO NOTHING',
  );
  const previous = db
    .prepare(
      `SELECT id,field_key AS field,value FROM profile_facts WHERE ${subject}
    AND source_kind='inferred' AND change_kind='set' AND source_at<=?`,
    )
    .all(scope.chatId, scope.generation, user, now) as {
    id: number;
    field: string;
    value: string;
  }[];
  for (const candidate of previous)
    if (
      inferenceField(candidate.field) === field &&
      inferenceValue(field, candidate.value) === value
    )
      mark.run(candidate.id, now);
}

export function inferenceAllowed(
  db: Database,
  scope: ConnectionScope,
  user: UserId,
  source: { readonly at: number; readonly text: string },
  candidate: { readonly fieldKey: string; readonly value: string },
  automatic: boolean,
) {
  const field = inferenceField(candidate.fieldKey);
  const rejectedAt = db
    .prepare(
      `SELECT max(rejected_at) FROM profile_inference_rejections WHERE ${subject}
    AND (field_key IN ('',?) OR value_key=?)`,
    )
    .pluck()
    .get(
      scope.chatId,
      scope.generation,
      user,
      fingerprint(field),
      fingerprint(inferenceValue(field, candidate.value)),
    ) as number | null;
  if (rejectedAt !== null && source.at <= rejectedAt) return false;
  return (
    (!automatic && rejectedAt === null) ||
    verifiedInference(source.text, candidate.fieldKey, candidate.value) !== null
  );
}
