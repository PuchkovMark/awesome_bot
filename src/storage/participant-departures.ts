import type { Database } from 'better-sqlite3';
import type { ConnectionScope, HumanMember, UserId } from '../contracts/index';
import { requireInput, timestamp } from './validation';

export const departureGraceMs = 30 * 86_400_000;
type ChatGeneration = Pick<ConnectionScope, 'chatId' | 'generation'>;

export interface ParticipantDeparture {
  readonly revision: number;
  readonly departedAt: number | null;
  readonly returnedAt: number | null;
  readonly purgedAt: number | null;
  readonly profileEpoch: number;
  readonly needsVerification: number;
}
export interface ScopedDeparture extends ParticipantDeparture, ChatGeneration {
  readonly user: UserId;
}
export const departureFields = `revision,departed_at AS departedAt,returned_at AS returnedAt,
  purged_at AS purgedAt,profile_epoch AS profileEpoch,needs_verification AS needsVerification`;
const subject = 'chat_id=@chatId AND generation=@generation AND user_id=@user';

export function readDeparture(db: Database, scope: ChatGeneration, user: UserId) {
  return db
    .prepare(`SELECT ${departureFields} FROM participant_departures WHERE ${subject}`)
    .get({ ...scope, user }) as ParticipantDeparture | undefined;
}

export function participantProfileAvailable(
  state: ParticipantDeparture | undefined,
  inputAt?: number,
) {
  return (
    !state ||
    (!state.needsVerification &&
      state.returnedAt !== null &&
      (inputAt === undefined || inputAt > state.returnedAt))
  );
}

export function startParticipantDeparture(
  db: Database,
  scope: ChatGeneration,
  user: UserId,
  at: number,
) {
  const args = { ...scope, user, at };
  const changed = db
    .prepare(
      `INSERT INTO participant_departures(chat_id,generation,user_id,departed_at)
    VALUES(@chatId,@generation,@user,@at) ON CONFLICT(chat_id,generation,user_id) DO UPDATE SET
      revision=revision+1,
      departed_at=CASE WHEN returned_at IS NULL THEN coalesce(departed_at,excluded.departed_at)
                       ELSE excluded.departed_at END,
      purged_at=CASE WHEN returned_at IS NULL THEN purged_at ELSE NULL END,
      returned_at=NULL,needs_verification=0
    WHERE returned_at IS NOT NULL OR departed_at IS NULL OR needs_verification=1`,
    )
    .run(args);
  if (!changed.changes) return;
  db.prepare(`DELETE FROM profile_command_lists WHERE ${subject}`).run(args);
  db.prepare(
    `DELETE FROM questionnaire_inputs WHERE chat_id=@chatId AND generation=@generation
    AND message_id=(SELECT source_id FROM questionnaire_progress WHERE ${subject} AND state='processing')`,
  ).run(args);
  db.prepare(
    `UPDATE questionnaire_progress SET state='paused',source_id=NULL
    WHERE ${subject} AND state IN ('showing','dispatching','active','processing')`,
  ).run(args);
}

/** Только данные профиля в заданном поколении, в транзакции ухода или сверки копии. */
export function eraseDepartedProfile(db: Database, scope: ChatGeneration, user: UserId) {
  requireInput(db.inTransaction);
  const args = { ...scope, user };
  db.prepare(
    `DELETE FROM questionnaire_inputs WHERE chat_id=@chatId AND generation=@generation
    AND attempt=(SELECT attempt FROM questionnaire_progress WHERE ${subject})`,
  ).run(args);
  for (const table of ['questionnaire_progress', 'profile_command_lists', 'address_preferences'])
    db.prepare(`DELETE FROM ${table} WHERE ${subject}`).run(args);
  db.prepare(
    `DELETE FROM profile_facts WHERE chat_id=@chatId AND user_id=@user
    AND (generation=@generation OR generation IS NULL)`,
  ).run(args);
  db.prepare('DELETE FROM participant_profiles WHERE chat_id=@chatId AND user_id=@user').run(args);
}

function expireDeparture(db: Database, row: ScopedDeparture, now: number) {
  const changed = db
    .prepare(
      `UPDATE participant_departures SET revision=revision+1,purged_at=@now,profile_epoch=revision+1
    WHERE ${subject} AND revision=@revision AND returned_at IS NULL AND purged_at IS NULL
      AND departed_at<=@cutoff`,
    )
    .run({ ...row, now, cutoff: now - departureGraceMs });
  if (changed.changes) eraseDepartedProfile(db, row, row.user);
  return changed.changes;
}

export function returnDepartedParticipant(
  db: Database,
  scope: ChatGeneration,
  user: UserId,
  at: number,
  confirmedAt: number,
) {
  const state = readDeparture(db, scope, user);
  if (!state || participantProfileAvailable(state)) return;
  const row = { ...scope, ...state, user };
  if (state.departedAt !== null && state.departedAt <= confirmedAt - departureGraceMs)
    expireDeparture(db, row, confirmedAt);
  db.prepare(
    `UPDATE participant_departures SET revision=revision+1,returned_at=@at,needs_verification=0
    WHERE ${subject}`,
  ).run({ ...scope, user, at });
}

export function applyDepartureSnapshot(
  db: Database,
  scope: ChatGeneration,
  members: readonly HumanMember[],
  at: number,
) {
  const args = { ...scope, members: JSON.stringify(members.map(({ userId }) => userId)) };
  const returning = db
    .prepare(
      `SELECT user_id FROM participant_departures WHERE chat_id=@chatId AND generation=@generation
    AND (returned_at IS NULL OR needs_verification=1)
    AND user_id IN (SELECT value FROM json_each(@members))`,
    )
    .pluck()
    .all(args) as UserId[];
  for (const user of returning) returnDepartedParticipant(db, scope, user, at, at);
  const leaving = db
    .prepare(
      `SELECT p.user_id FROM chat_participants p LEFT JOIN participant_departures d
      ON (d.chat_id,d.generation,d.user_id)=(p.chat_id,@generation,p.user_id)
    WHERE p.chat_id=@chatId AND p.user_id NOT IN (SELECT value FROM json_each(@members))
    AND (p.status='present' OR (d.returned_at IS NULL AND d.departed_at IS NULL
      AND p.status IN ('absent','left','removed') AND d.revision IS NOT NULL
      AND d.needs_verification=0))`,
    )
    .pluck()
    .all(args) as UserId[];
  for (const user of leaving) startParticipantDeparture(db, scope, user, at);
}

export const departedProfileBatch = 100;

export function purgeDepartedProfiles(db: Database, now: number, limit = departedProfileBatch) {
  requireInput(
    db.inTransaction && Number.isInteger(limit) && limit > 0 && limit <= departedProfileBatch,
  );
  timestamp(now);
  const due = db
    .prepare(
      `SELECT chat_id AS chatId,generation,user_id AS user,${departureFields}
    FROM participant_departures WHERE returned_at IS NULL AND purged_at IS NULL AND departed_at<=?
    ORDER BY departed_at,chat_id,generation,user_id LIMIT ?`,
    )
    .all(now - departureGraceMs, limit) as ScopedDeparture[];
  let cleaned = 0;
  for (const row of due) cleaned += expireDeparture(db, row, now);
  return cleaned;
}
