import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { ChatId, ConnectionScope } from '../contracts/index';
import type { Connection } from './connection';
import type { LlmUsage } from '../llm/types';
import {
  profileUpdateAllowance,
  deleteUnsentTokenReservation,
  insertTokenReservation,
  reconcileTokenReservation,
} from './token-budget-store';
import { historyBounds } from './history-retention-store';
import type { LifecycleBackend } from './lifecycle-store';
import { actualMessage, sourceAdmitted, type ProfileUpdateSource } from './profile-update-intake';
import type { Storage } from './types';
import { requireInput, timestamp } from './validation';

export const profileUpdateBatchSize = 10;
export const profileUpdateWaitMs = 3_600_000;
export const profileUpdateIntervalMs = 300_000;
const inScope = 'chat_id=? AND generation=?';

type WaitingSource = ProfileUpdateSource & { readonly queuedAt: number };
type MissingSource = { readonly id: number; readonly user: null };
interface Candidate {
  readonly ids: readonly number[];
  readonly input: number;
  readonly output: number;
}
export interface ProfileUpdateAttempt {
  readonly scope: ConnectionScope;
  readonly key: string;
  readonly ids: readonly number[];
}
interface Run {
  readonly at: number;
  readonly key: string | null;
}

function enabled(db: Database, scope: ConnectionScope) {
  return !!db.prepare('SELECT 1 FROM chats WHERE chat_id=? AND enabled=1').get(scope.chatId);
}

function previousRun(db: Database, scope: ConnectionScope) {
  return db
    .prepare(`SELECT started_at AS at,attempt_key AS key FROM profile_update_runs WHERE ${inScope}`)
    .get(scope.chatId, scope.generation) as Run | undefined;
}

function forgetWaiting(db: Database, scope: ConnectionScope, ids: readonly number[]) {
  if (!ids.length) return;
  db.prepare(
    `DELETE FROM profile_update_waiting WHERE ${inScope} AND message_id IN (SELECT value FROM json_each(?))`,
  ).run(scope.chatId, scope.generation, JSON.stringify(ids));
}

function readySources(db: Database, scope: ConnectionScope, now: number) {
  const run = previousRun(db, scope);
  if (!enabled(db, scope) || (run && now - run.at < profileUpdateIntervalMs)) return null;
  const bounds = historyBounds(db, scope.chatId, now);
  const sources: WaitingSource[] = [];
  const withdrawn: number[] = [];
  for (const source of db
    .prepare(
      `SELECT w.message_id AS id,m.user_id AS user,m.text,m.timestamp AS at,w.queued_at AS queuedAt
    FROM profile_update_waiting w LEFT JOIN personal_visible_messages m
      ON m.id=w.message_id AND m.chat_id=w.chat_id AND m.id>? AND m.timestamp>? AND ${actualMessage}
    WHERE w.chat_id=? AND w.generation=? ORDER BY w.queued_at,w.message_id`,
    )
    .iterate(
      bounds.clearedThrough,
      bounds.expiredThrough,
      scope.chatId,
      scope.generation,
    ) as Iterable<WaitingSource | MissingSource>) {
    if (source.user === null || !sourceAdmitted(db, scope, source)) withdrawn.push(source.id);
    else if (sources.push(source) === profileUpdateBatchSize) break;
  }
  forgetWaiting(db, scope, withdrawn);
  if (
    !sources.length ||
    (sources.length < profileUpdateBatchSize && now - sources[0]!.queuedAt < profileUpdateWaitMs)
  )
    return null;
  return sources.map(({ id, user, text, at }): ProfileUpdateSource => ({ id, user, text, at }));
}

function batchStillAdmitted(
  db: Database,
  scope: ConnectionScope,
  ids: readonly number[],
  now: number,
) {
  if (!enabled(db, scope)) return false;
  const bounds = historyBounds(db, scope.chatId, now);
  const sources = db
    .prepare(
      `SELECT m.id,m.user_id AS user,m.text,m.timestamp AS at
      FROM profile_update_waiting w JOIN personal_visible_messages m ON m.id=w.message_id AND m.chat_id=w.chat_id
      WHERE w.chat_id=? AND w.generation=? AND m.id>? AND m.timestamp>? AND ${actualMessage}
       AND m.id IN (SELECT value FROM json_each(?))`,
    )
    .all(
      scope.chatId,
      scope.generation,
      bounds.clearedThrough,
      bounds.expiredThrough,
      JSON.stringify(ids),
    ) as ProfileUpdateSource[];
  return (
    sources.length === ids.length && sources.every((source) => sourceAdmitted(db, scope, source))
  );
}

function directWaiting(db: Database, scope: ConnectionScope, now: number) {
  return !!db
    .prepare(
      `SELECT 1 FROM queue_jobs WHERE ${inScope}
     AND route_kind IN ('direct_message','mention','reply','name')
     AND (state='running' OR (state='queued' AND expires_at>?)) LIMIT 1`,
    )
    .get(scope.chatId, scope.generation, now);
}

export function createProfileUpdateStore(connection: Connection, lifecycle: LifecycleBackend) {
  const previous = new WeakMap<ProfileUpdateAttempt, Run | undefined>();
  return {
    schedule(now: number) {
      timestamp(now);
      return connection.run(
        (db) =>
          db
            .prepare(
              `SELECT w.chat_id AS chatId,w.generation,
          max(CASE WHEN count(*)>=@size THEN @now ELSE min(w.queued_at)+@wait END,
              coalesce(r.started_at+@interval,0)) AS dueAt
        FROM profile_update_waiting w JOIN chat_connections c USING(chat_id,generation)
        JOIN chats s USING(chat_id) LEFT JOIN profile_update_runs r USING(chat_id,generation)
        WHERE c.state='active' AND s.enabled=1 GROUP BY w.chat_id,w.generation ORDER BY dueAt,w.chat_id`,
            )
            .all({
              now,
              size: profileUpdateBatchSize,
              wait: profileUpdateWaitMs,
              interval: profileUpdateIntervalMs,
            }) as { chatId: ChatId; generation: number; dueAt: number }[],
      );
    },
    ready(scope: ConnectionScope, now: number) {
      timestamp(now);
      return lifecycle.transaction(scope, (db) =>
        directWaiting(db, scope, now) ? null : readySources(db, scope, now),
      );
    },
    begin(
      scope: ConnectionScope,
      now: number,
      group: boolean,
      candidates: readonly Candidate[],
    ): ProfileUpdateAttempt | null {
      timestamp(now);
      return lifecycle.transaction(scope, (db) => {
        if (directWaiting(db, scope, now)) return null;
        const ready = readySources(db, scope, now);
        if (!ready) return null;
        const allowance = profileUpdateAllowance(db, scope, group, now);
        const candidate = candidates.find(({ ids, input, output }) => {
          timestamp(input);
          timestamp(output);
          return (
            ids.length > 0 &&
            input <= allowance &&
            output <= allowance - input &&
            ids.every((id, index) => ready[index]?.id === id)
          );
        });
        if (!candidate) return null;
        const former = previousRun(db, scope);
        const { ids, input, output } = candidate;
        const key = randomUUID();
        insertTokenReservation(db, scope, { purpose: 'profile_update', key, input, output }, now);
        db.prepare(
          `INSERT INTO profile_update_runs(chat_id,generation,started_at,attempt_key) VALUES(?,?,?,?)
          ON CONFLICT(chat_id,generation) DO UPDATE SET started_at=excluded.started_at,attempt_key=excluded.attempt_key`,
        ).run(scope.chatId, scope.generation, now, key);
        const attempt = { scope, key, ids: [...ids] };
        previous.set(attempt, former);
        return attempt;
      });
    },
    reconcile({ scope, key }: ProfileUpdateAttempt, usage: LlmUsage) {
      return connection.run((db) => reconcileTokenReservation(db, scope, key, usage));
    },
    cancelBeforeSend(attempt: ProfileUpdateAttempt) {
      const { scope, key } = attempt;
      const former = previous.get(attempt);
      return lifecycle.transaction(scope, (db) => {
        if (previousRun(db, scope)?.key !== key || !deleteUnsentTokenReservation(db, scope, key))
          return;
        if (former)
          db.prepare(
            `UPDATE profile_update_runs SET started_at=?,attempt_key=? WHERE ${inScope}`,
          ).run(former.at, former.key, scope.chatId, scope.generation);
        else
          db.prepare(`DELETE FROM profile_update_runs WHERE ${inScope}`).run(
            scope.chatId,
            scope.generation,
          );
      });
    },
    finish(attempt: ProfileUpdateAttempt, now: number, consumed: boolean, apply?: () => void) {
      timestamp(now);
      const { scope, key, ids } = attempt;
      return lifecycle.transaction(scope, (db) => {
        const run = previousRun(db, scope);
        if (run?.key !== key || now - run.at >= profileUpdateIntervalMs) return false;
        db.prepare(`UPDATE profile_update_runs SET attempt_key=NULL WHERE ${inScope}`).run(
          scope.chatId,
          scope.generation,
        );
        const admitted = !apply || (consumed && batchStillAdmitted(db, scope, ids, now));
        if (admitted) apply?.();
        if (consumed) forgetWaiting(db, scope, ids);
        return admitted;
      });
    },
  };
}

const updates = new WeakMap<Storage, ReturnType<typeof createProfileUpdateStore>>();
export function registerProfileUpdates(
  storage: Storage,
  store: ReturnType<typeof createProfileUpdateStore>,
) {
  updates.set(storage, store);
}
export function profileUpdateStore(storage: Storage) {
  const store = updates.get(storage);
  requireInput(store);
  return store;
}
