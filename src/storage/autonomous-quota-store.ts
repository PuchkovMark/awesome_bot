import type { Database } from 'better-sqlite3';
import type { ConnectionScope } from '../contracts/index';
import { autonomousDayMs, autonomousHourMs, type ChatLimits } from '../core/chat-limits/config';
import { allowsAutonomousReply, readChatControl } from './chat-control-store';
import { requireInput, timestamp } from './validation';

declare const reservationBrand: unique symbol;
export type AutonomousReservation = { readonly [reservationBrand]: true };

type ReservationKey = { readonly scope: ConnectionScope; readonly id: number };
type Transaction = <T>(operation: (db: Database) => T) => T;
const noReactionMs = 30 * 60_000;

export function autonomousQuotaState(
  db: Database,
  scope: ConnectionScope,
  limits: ChatLimits,
  now: number,
  requireReaction = false,
) {
  timestamp(now);
  const { chatId, generation } = scope;
  const { hourly, daily } = db
    .prepare(
      `SELECT count(*) AS daily, count(CASE WHEN reserved_at>? THEN 1 END) AS hourly
    FROM autonomous_quota_reservations WHERE chat_id=? AND generation=? AND reserved_at>? AND reserved_at<=?`,
    )
    .get(now - autonomousHourMs, chatId, generation, now - autonomousDayMs, now) as {
    hourly: number;
    daily: number;
  };
  const last = db
    .prepare(
      `SELECT coalesce(first_confirmed_at, CASE WHEN outcome='unknown' THEN attempted_at END) AS intervalFrom,
      reacted_at AS reactedAt
      FROM autonomous_quota_reservations WHERE chat_id=? AND generation=?
      AND (first_confirmed_at IS NOT NULL OR outcome='unknown')
      ORDER BY intervalFrom DESC,id DESC LIMIT 1`,
    )
    .get(chatId, generation) as { intervalFrom: number; reactedAt: number | null } | undefined;
  const intervalFrom = last?.intervalFrom ?? null;
  const open = !!db
    .prepare(
      `SELECT 1 FROM autonomous_quota_reservations
    WHERE chat_id=? AND generation=? AND owner IS NOT NULL`,
    )
    .get(chatId, generation);
  const intervalUntil = intervalFrom === null ? null : intervalFrom + limits.autonomousIntervalMs;
  if (intervalUntil !== null) timestamp(intervalUntil);
  const allowed =
    !open &&
    hourly < limits.autonomousPerHour &&
    daily < limits.autonomousPerDay &&
    (intervalUntil === null || now >= intervalUntil) &&
    (!requireReaction ||
      !last ||
      last.reactedAt !== null ||
      now >= last.intervalFrom + noReactionMs) &&
    allowsAutonomousReply(readChatControl(db, chatId), now);
  return { hourly, daily, open, intervalFrom, intervalUntil, allowed };
}

export function recordAutonomousReaction(
  db: Database,
  scope: ConnectionScope,
  replyTo: string,
  now: number,
) {
  db.prepare(
    `UPDATE autonomous_quota_reservations SET reacted_at=?
    WHERE chat_id=? AND generation=? AND first_confirmed_at<=? AND reacted_at IS NULL AND id=(
      SELECT p.reservation_id FROM autonomous_reply_parts p JOIN messages m ON m.id=p.message_id
      WHERE m.chat_id=? AND m.platform_message_id=?
    )`,
  ).run(now, scope.chatId, scope.generation, now, scope.chatId, replyTo);
}

export function createAutonomousQuotaStore(
  transaction: Transaction,
  assertScope: (db: Database, scope: ConnectionScope) => void,
  owner: string,
  limits: ChatLimits,
) {
  const reservations = new WeakMap<AutonomousReservation, ReservationKey>();
  function keyFor(reservation: AutonomousReservation) {
    const entry = reservations.get(reservation);
    requireInput(entry);
    return entry;
  }
  function parameters(reservation: AutonomousReservation) {
    const { id, scope } = keyFor(reservation);
    return [id, scope.chatId, scope.generation, owner] as const;
  }

  return Object.freeze({
    inspect(scope: ConnectionScope, now: number, requireReaction = false) {
      return transaction((db) => {
        assertScope(db, scope);
        return autonomousQuotaState(db, scope, limits, now, requireReaction);
      });
    },
    reserve(
      scope: ConnectionScope,
      now: number,
      requireReaction = false,
    ): AutonomousReservation | null {
      const id = transaction((db) => {
        assertScope(db, scope);
        if (!autonomousQuotaState(db, scope, limits, now, requireReaction).allowed) return null;
        const row = db
          .prepare(
            `INSERT INTO autonomous_quota_reservations(chat_id,generation,reserved_at,owner)
          VALUES(?,?,?,?) RETURNING id`,
          )
          .get(scope.chatId, scope.generation, now, owner) as { id: number };
        return row.id;
      });
      if (id === null) return null;
      const reservation = Object.freeze({}) as AutonomousReservation;
      reservations.set(reservation, { scope, id });
      return reservation;
    },
    beginAttempt(reservation: AutonomousReservation, now: number): number | null {
      timestamp(now);
      const { id, scope } = keyFor(reservation);
      return transaction((db) => {
        assertScope(db, scope);
        if (!allowsAutonomousReply(readChatControl(db, scope.chatId), now)) return null;
        const row = db
          .prepare(
            `UPDATE autonomous_quota_reservations SET attempted_at=?, attempt=attempt+1
          WHERE id=? AND chat_id=? AND generation=? AND owner=? AND attempted_at IS NULL
            AND reserved_at<=? AND (first_confirmed_at IS NULL OR first_confirmed_at<=?) AND attempt<9007199254740991
          RETURNING attempt`,
          )
          .get(now, id, scope.chatId, scope.generation, owner, now, now) as
          { attempt: number } | undefined;
        return row?.attempt ?? null;
      });
    },
    confirmPart(reservation: AutonomousReservation, attempt: number, now: number) {
      timestamp(now);
      requireInput(Number.isSafeInteger(attempt) && attempt > 0);
      return transaction(
        (db) =>
          db
            .prepare(
              `UPDATE autonomous_quota_reservations
        SET first_confirmed_at=coalesce(first_confirmed_at,?), attempted_at=NULL
        WHERE id=? AND chat_id=? AND generation=? AND owner=? AND attempt=? AND attempted_at<=?`,
            )
            .run(now, ...parameters(reservation), attempt, now).changes === 1,
      );
    },
    recordDeliveredPart(
      reservation: AutonomousReservation,
      attempt: number,
      platformMessageId: string,
      now: number,
    ) {
      timestamp(now);
      const { id, scope } = keyFor(reservation);
      return transaction((db) => {
        const updated = db
          .prepare(
            `UPDATE autonomous_quota_reservations
          SET first_confirmed_at=coalesce(first_confirmed_at,?),attempted_at=NULL
          WHERE id=? AND chat_id=? AND generation=? AND owner=? AND attempt=?
            AND (attempted_at<=? OR first_confirmed_at IS NOT NULL)`,
          )
          .run(now, ...parameters(reservation), attempt, now);
        if (updated.changes !== 1) return false;
        const row = db
          .prepare(
            "SELECT id FROM messages WHERE chat_id=? AND platform_message_id=? AND role='assistant' AND purpose='conversation'",
          )
          .get(scope.chatId, platformMessageId) as { id: number } | undefined;
        requireInput(row);
        db.prepare(
          'INSERT INTO autonomous_reply_parts(message_id,reservation_id) VALUES(?,?) ON CONFLICT DO NOTHING',
        ).run(row.id, id);
        return true;
      });
    },
    rejectAttempt(reservation: AutonomousReservation, attempt: number) {
      requireInput(Number.isSafeInteger(attempt) && attempt > 0);
      return transaction(
        (db) =>
          db
            .prepare(
              `UPDATE autonomous_quota_reservations SET attempted_at=NULL
        WHERE id=? AND chat_id=? AND generation=? AND owner=? AND attempt=? AND attempted_at IS NOT NULL`,
            )
            .run(...parameters(reservation), attempt).changes === 1,
      );
    },
    finish(reservation: AutonomousReservation) {
      return transaction((db) => {
        const binding = parameters(reservation);
        const row = db
          .prepare(
            `UPDATE autonomous_quota_reservations
          SET owner=NULL, outcome=CASE WHEN first_confirmed_at IS NULL THEN 'unknown' ELSE 'delivered' END
          WHERE id=? AND chat_id=? AND generation=? AND owner=? AND (first_confirmed_at IS NOT NULL OR attempted_at IS NOT NULL)
          RETURNING outcome`,
          )
          .get(...binding) as { outcome: 'delivered' | 'unknown' } | undefined;
        if (row) return row.outcome;
        const removed = db
          .prepare(
            'DELETE FROM autonomous_quota_reservations WHERE id=? AND chat_id=? AND generation=? AND owner=?',
          )
          .run(...binding).changes;
        return removed ? ('released' as const) : null;
      });
    },
  });
}

export function restoreAutonomousQuota(db: Database, prefix: string | null) {
  const scope = 'owner IS NOT NULL AND (? IS NULL OR substr(chat_id,1,length(?))=?)';
  db.prepare(
    `DELETE FROM autonomous_quota_reservations WHERE ${scope}
    AND first_confirmed_at IS NULL AND attempted_at IS NULL`,
  ).run(prefix, prefix, prefix);
  db.prepare(
    `UPDATE autonomous_quota_reservations
    SET owner=NULL, outcome=CASE WHEN first_confirmed_at IS NULL THEN 'unknown' ELSE 'delivered' END
    WHERE ${scope}`,
  ).run(prefix, prefix, prefix);
}

export function pruneAutonomousQuota(
  db: Database,
  limits: ChatLimits,
  now: number,
  prefix: string | null,
) {
  return db
    .prepare(
      `DELETE FROM autonomous_quota_reservations WHERE id IN (
    SELECT id FROM autonomous_quota_reservations WHERE owner IS NULL AND reserved_at<=?
      AND coalesce(first_confirmed_at,attempted_at)<=? AND (? IS NULL OR substr(chat_id,1,length(?))=?)
    ORDER BY reserved_at,id LIMIT 100)`,
    )
    .run(
      now - autonomousDayMs,
      now - Math.max(limits.autonomousIntervalMs, noReactionMs),
      prefix,
      prefix,
      prefix,
    ).changes;
}
