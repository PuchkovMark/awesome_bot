import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { ChatId, ConnectionScope } from '../contracts/index';
import type { Connection } from './connection';
import type { LlmUsage } from '../llm/types';
import {
  canReserveTokens,
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

interface WaitingSource extends ProfileUpdateSource {
  readonly queuedAt: number;
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
  db.prepare(
    `DELETE FROM profile_update_waiting WHERE ${inScope} AND NOT EXISTS (
      SELECT 1 FROM personal_visible_messages m
      WHERE m.id=profile_update_waiting.message_id AND m.chat_id=profile_update_waiting.chat_id
        AND m.id>? AND m.timestamp>? AND ${actualMessage})`,
  ).run(scope.chatId, scope.generation, bounds.clearedThrough, bounds.expiredThrough);
  const sources: WaitingSource[] = [];
  const withdrawn: number[] = [];
  for (const source of db
    .prepare(
      `SELECT m.id,m.user_id AS user,m.text,m.timestamp AS at,w.queued_at AS queuedAt
      FROM profile_update_waiting w JOIN messages m ON m.id=w.message_id AND m.chat_id=w.chat_id
      WHERE w.chat_id=? AND w.generation=? ORDER BY w.queued_at,w.message_id`,
    )
    .iterate(scope.chatId, scope.generation) as Iterable<WaitingSource>) {
    if (!sourceAdmitted(db, scope, source)) withdrawn.push(source.id);
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

export function createProfileUpdateStore(connection: Connection, lifecycle: LifecycleBackend) {
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
      return lifecycle.transaction(scope, (db) => readySources(db, scope, now));
    },
    begin(
      scope: ConnectionScope,
      ids: readonly number[],
      now: number,
      budget: { readonly group: boolean; readonly input: number; readonly output: number },
    ): ProfileUpdateAttempt | null {
      timestamp(now);
      requireInput(ids.length > 0 && ids.length <= profileUpdateBatchSize);
      return lifecycle.transaction(scope, (db) => {
        const ready = readySources(db, scope, now);
        if (!ready || !ids.every((id, index) => ready[index]?.id === id)) return null;
        if (
          db
            .prepare(
              `SELECT 1 FROM queue_jobs WHERE ${inScope}
          AND route_kind IN ('direct_message','mention','reply','name')
          AND (state='running' OR (state='queued' AND expires_at>?)) LIMIT 1`,
            )
            .get(scope.chatId, scope.generation, now)
        )
          return null;
        const key = randomUUID();
        const reservation = {
          purpose: 'profile_update' as const,
          key,
          input: budget.input,
          output: budget.output,
        };
        if (!canReserveTokens(db, scope, budget.group, reservation, now)) return null;
        insertTokenReservation(db, scope, reservation, now);
        db.prepare(
          `INSERT INTO profile_update_runs(chat_id,generation,started_at,attempt_key) VALUES(?,?,?,?)
          ON CONFLICT(chat_id,generation) DO UPDATE SET started_at=excluded.started_at,attempt_key=excluded.attempt_key`,
        ).run(scope.chatId, scope.generation, now, key);
        return { scope, key, ids: [...ids] };
      });
    },
    reconcile({ scope, key }: ProfileUpdateAttempt, usage: LlmUsage) {
      return connection.run((db) => reconcileTokenReservation(db, scope, key, usage));
    },
    finish(attempt: ProfileUpdateAttempt, now: number, consumed: boolean) {
      timestamp(now);
      const { scope, key, ids } = attempt;
      return lifecycle.transaction(scope, (db) => {
        const run = previousRun(db, scope);
        if (run?.key !== key || now - run.at >= profileUpdateIntervalMs) return false;
        db.prepare(`UPDATE profile_update_runs SET attempt_key=NULL WHERE ${inScope}`).run(
          scope.chatId,
          scope.generation,
        );
        if (consumed) forgetWaiting(db, scope, ids);
        return true;
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
