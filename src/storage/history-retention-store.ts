import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { ChatId, ConnectionScope, UserId } from '../contracts/index';
import type { Connection } from './connection';
import type { LifecycleBackend } from './lifecycle-store';
import type { MessageInput } from './types';

export const HISTORY_CONFIRMATION_MS = 5 * 60_000;
const BATCH_SIZE = 100;
interface HistoryBounds {
  readonly clearedThrough: number;
  readonly expiredThrough: number;
}

export function historyBounds(db: Database, chatId: string, now = Date.now()): HistoryBounds {
  const policy = db
    .prepare('SELECT retention_ms AS duration FROM history_retention_policy WHERE singleton=1')
    .get() as { duration: number } | undefined;
  const boundary = db
    .prepare(
      `SELECT b.cleared_through AS clearedThrough,b.expired_through AS expiredThrough
    FROM history_retention_boundaries b JOIN chat_connections c USING(chat_id,generation) WHERE b.chat_id=?`,
    )
    .get(chatId) as HistoryBounds | undefined;
  return {
    clearedThrough: boundary?.clearedThrough ?? 0,
    expiredThrough: Math.max(boundary?.expiredThrough ?? -1, policy ? now - policy.duration : -1),
  };
}

export function applyHistoryRetention(db: Database, duration: number, now: number) {
  const previous = db
    .prepare('SELECT retention_ms AS duration FROM history_retention_policy WHERE singleton=1')
    .get() as { duration: number } | undefined;
  if (previous && duration > previous.duration) {
    db.prepare(
      `INSERT INTO history_retention_boundaries(chat_id,generation,expired_through)
      SELECT chat_id,generation,? FROM chat_connections WHERE 1
      ON CONFLICT(chat_id,generation) DO UPDATE SET expired_through=max(expired_through,excluded.expired_through)`,
    ).run(Math.max(-1, now - previous.duration));
  }
  db.prepare(
    `INSERT INTO history_retention_policy VALUES(1,?)
    ON CONFLICT(singleton) DO UPDATE SET retention_ms=excluded.retention_ms`,
  ).run(duration);
}

export function acceptsHistoryInput(
  db: Database,
  scope: ConnectionScope,
  message: MessageInput,
  now?: number,
) {
  return (
    message.timestamp > historyBounds(db, scope.chatId, now).expiredThrough &&
    !db
      .prepare(
        'SELECT 1 FROM personal_deletions WHERE chat_id=? AND generation=? AND user_id=? AND confirmed_at>=? LIMIT 1',
      )
      .get(scope.chatId, scope.generation, message.userId, message.timestamp) &&
    !db
      .prepare(
        'SELECT 1 FROM history_deleted_inputs WHERE chat_id=? AND generation=? AND platform_message_id=?',
      )
      .get(scope.chatId, scope.generation, message.messageId)
  );
}

export function historySourcesVisible(
  db: Database,
  chatId: ChatId,
  ids: readonly number[],
  now?: number,
) {
  const boundary = historyBounds(db, chatId, now);
  const { count } = db
    .prepare(
      `SELECT count(*) AS count FROM personal_visible_messages
    WHERE chat_id=? AND id>? AND timestamp>? AND id IN (SELECT value FROM json_each(?))`,
    )
    .get(chatId, boundary.clearedThrough, boundary.expiredThrough, JSON.stringify(ids)) as {
    count: number;
  };
  return count === ids.length;
}

interface Candidate {
  id: number;
  chatId: string;
  generation: number;
  messageId: string;
  timestamp: number;
  mark: number;
}

/** Called with the queue lease held, including for paused generations. */
export function pruneHistoryMessages(db: Database, duration: number, now: number): boolean {
  const deadline = now - duration;
  const rows = db
    .prepare(
      `
    WITH aged AS (SELECT id FROM messages WHERE timestamp<=? ORDER BY timestamp,id LIMIT ?),
    manually_cleared AS (
      SELECT m.id FROM history_retention_boundaries b
      CROSS JOIN messages m ON m.chat_id=b.chat_id AND m.id<=b.cleared_through
      WHERE b.cleared_through>0 LIMIT ?
    ),
    previously_expired AS (
      SELECT m.id FROM history_retention_boundaries b
      CROSS JOIN messages m ON m.chat_id=b.chat_id AND m.timestamp<=b.expired_through
      WHERE b.expired_through>? LIMIT ?
    ),
    batch AS (SELECT id FROM aged UNION SELECT id FROM manually_cleared UNION SELECT id FROM previously_expired)
    SELECT m.id,m.chat_id AS chatId,c.generation,m.platform_message_id AS messageId,m.timestamp,
      (m.role='user' AND m.id<=coalesce(b.cleared_through,0)) AS mark
    FROM batch JOIN messages m USING(id) JOIN chat_connections c ON c.chat_id=m.chat_id
    LEFT JOIN history_retention_boundaries b ON b.chat_id=c.chat_id AND b.generation=c.generation
    ORDER BY m.id LIMIT ?`,
    )
    .all(deadline, BATCH_SIZE, BATCH_SIZE, deadline, BATCH_SIZE, BATCH_SIZE) as Candidate[];
  const remember = db.prepare('INSERT OR IGNORE INTO history_deleted_inputs VALUES(?,?,?)');
  const advanceExpiry =
    db.prepare(`INSERT INTO history_retention_boundaries(chat_id,generation,expired_through) VALUES(?,?,?)
    ON CONFLICT(chat_id,generation) DO UPDATE SET expired_through=max(expired_through,excluded.expired_through)`);
  const facts = db.prepare(
    "DELETE FROM profile_facts WHERE chat_id=? AND source_kind<>'self' AND source_message_id=?",
  );
  const remove = db.prepare('DELETE FROM messages WHERE id=?');
  for (const row of rows) {
    if (row.mark) remember.run(row.chatId, row.generation, row.messageId);
    if (row.timestamp <= deadline) advanceExpiry.run(row.chatId, row.generation, row.timestamp);
    facts.run(row.chatId, row.messageId);
    remove.run(row.id);
  }
  for (const chatId of new Set(rows.map((row) => row.chatId))) removeUnknownFacts(db, chatId);
  return rows.length === BATCH_SIZE;
}

function removeUnknownFacts(db: Database, chatId: string) {
  db.prepare(
    `DELETE FROM profile_facts WHERE chat_id=? AND (source_kind='inferred' OR
    (source_kind='admin' AND source_message_id IS NOT NULL)) AND NOT EXISTS (SELECT 1 FROM messages m
      WHERE m.chat_id=profile_facts.chat_id AND m.platform_message_id=profile_facts.source_message_id)`,
  ).run(chatId);
}

export interface HistoryClearOrigin {
  readonly initiator: UserId;
  readonly origin: ChatId;
  readonly owner: boolean;
}
interface ClearRequest {
  readonly code: string;
  readonly count: number;
  readonly expiresAt: number;
  readonly state: 'pending' | 'confirmed' | 'invalidated';
}
export function createHistoryClearStore(connection: Connection, lifecycle: LifecycleBackend) {
  return {
    /** The caller checks authorization in the enclosing synchronous transaction. */
    request(
      scope: ConnectionScope,
      source: HistoryClearOrigin,
      eventId: string,
      now: number,
      replayOnly: boolean,
    ): ClearRequest | null {
      return lifecycle.transaction(scope, (db) => {
        const current = db
          .prepare(
            `SELECT code,message_count AS count,expires_at AS expiresAt,state FROM history_clear_requests
          WHERE chat_id=? AND generation=? AND origin_id=? AND event_id=? AND initiator_id=?`,
          )
          .get(scope.chatId, scope.generation, source.origin, eventId, source.initiator) as
          ClearRequest | undefined;
        if (current || replayOnly) return current ?? null;
        const boundary = historyBounds(db, scope.chatId, now);
        const snapshot = db
          .prepare(
            `SELECT count(*) FILTER (WHERE id>? AND timestamp>?) AS count,coalesce(max(id),0) AS throughId
          FROM messages WHERE chat_id=?`,
          )
          .get(boundary.clearedThrough, boundary.expiredThrough, scope.chatId) as {
          count: number;
          throughId: number;
        };
        const code = randomBytes(16).toString('hex');
        const expiresAt = now + HISTORY_CONFIRMATION_MS;
        db.prepare(
          `INSERT INTO history_clear_requests
          (code,chat_id,generation,initiator_id,origin_id,owner_request,event_id,through_id,message_count,expires_at,state)
          VALUES(?,?,?,?,?,?,?,?,?,?,'pending')`,
        ).run(
          code,
          scope.chatId,
          scope.generation,
          source.initiator,
          source.origin,
          Number(source.owner),
          eventId,
          snapshot.throughId,
          snapshot.count,
          expiresAt,
        );
        return { code, count: snapshot.count, expiresAt, state: 'pending' };
      });
    },
    privateTarget(
      source: HistoryClearOrigin,
      code: string,
    ): { chatId: ChatId; generation: number } | undefined {
      return connection.run(
        (db) =>
          db
            .prepare(
              `SELECT chat_id AS chatId,generation FROM history_clear_requests
        WHERE code=? AND initiator_id=? AND origin_id=? AND owner_request=1`,
            )
            .get(code, source.initiator, source.origin) as
            { chatId: ChatId; generation: number } | undefined,
      );
    },
    confirm(scope: ConnectionScope, source: HistoryClearOrigin, code: string, now: number) {
      return lifecycle.transaction(scope, (db) => {
        const request = db
          .prepare(
            `UPDATE history_clear_requests SET state='confirmed'
          WHERE code=? AND chat_id=? AND generation=? AND initiator_id=? AND origin_id=? AND owner_request=?
            AND state='pending' AND expires_at>?
          RETURNING through_id AS throughId,message_count AS count`,
          )
          .get(
            code,
            scope.chatId,
            scope.generation,
            source.initiator,
            source.origin,
            Number(source.owner),
            now,
          ) as { throughId: number; count: number } | undefined;
        if (!request) return null;
        db.prepare(
          `INSERT INTO history_retention_boundaries(chat_id,generation,cleared_through) VALUES(?,?,?)
          ON CONFLICT(chat_id,generation) DO UPDATE SET cleared_through=max(cleared_through,excluded.cleared_through)`,
        ).run(scope.chatId, scope.generation, request.throughId);
        db.prepare(
          'DELETE FROM profile_update_waiting WHERE chat_id=? AND generation=? AND message_id<=?',
        ).run(scope.chatId, scope.generation, request.throughId);
        db.prepare(
          `DELETE FROM profile_facts WHERE chat_id=? AND generation=? AND source_kind='inferred'
          AND source_message_id IN (SELECT platform_message_id FROM messages WHERE chat_id=? AND id<=?)`,
        ).run(scope.chatId, scope.generation, scope.chatId, request.throughId);
        removeUnknownFacts(db, scope.chatId);
        return { count: request.count };
      });
    },
  };
}

type HistoryClearStore = ReturnType<typeof createHistoryClearStore>;
const stores = new WeakMap<object, HistoryClearStore>();
export function registerHistoryClear(storage: object, store: HistoryClearStore) {
  stores.set(storage, store);
}
export function historyClearStore(storage: object): HistoryClearStore {
  const store = stores.get(storage);
  if (!store) throw new TypeError('History retention: unavailable');
  return store;
}
