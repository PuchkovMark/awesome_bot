import { createHash, randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { ConnectionScope } from '../contracts/index';
import { historyBounds, historySourcesVisible } from './history-retention-store';
import { readRecapInput } from './recap-clarifications';
import { lifecycleBackend } from './lifecycle-store';

export interface SummaryPeriod {
  readonly from: number;
  readonly to: number;
  readonly timezone: string;
}
export type SummaryLevel = 'fragment' | 'day' | 'rolling';
export interface SummaryEntry {
  readonly id: number;
  readonly level: SummaryLevel;
  readonly text: string;
  readonly from: number;
  readonly to: number;
  readonly lastId: number;
  readonly count: number;
}
export interface SummaryMessage {
  readonly id: number;
  readonly timestamp: number;
  readonly author: string;
  readonly text: string;
}
const fields =
  's.id,s.level,s.text,s.starts_at AS "from",s.ends_at AS "to",s.last_id AS lastId,s.source_count AS count';
const visible = "m.chat_id=? AND m.purpose='conversation' AND m.id>? AND m.timestamp>?";

function parameters(db: Database, scope: ConnectionScope) {
  const bounds = historyBounds(db, scope.chatId);
  return [scope.chatId, bounds.clearedThrough, bounds.expiredThrough];
}
function sourceIds(db: Database, id: number): number[] {
  return db
    .prepare('SELECT message_id FROM chat_summary_sources WHERE summary_id=? ORDER BY message_id')
    .pluck()
    .all(id) as number[];
}
function valid(db: Database, scope: ConnectionScope, id: number) {
  const stored = db
    .prepare('SELECT source_count FROM chat_summaries WHERE chat_id=? AND generation=? AND id=?')
    .pluck()
    .get(scope.chatId, scope.generation, id);
  if (typeof stored !== 'number' || stored === 0) return false;
  const ids = sourceIds(db, id);
  return ids.length === stored && historySourcesVisible(db, scope.chatId, ids);
}

export function chatSummaryStore(storage: object) {
  const life = lifecycleBackend(storage);
  return {
    recapInput(scope: ConnectionScope, input: number) {
      return life.transaction(scope, (db) => readRecapInput(db, scope, input));
    },
    hasComposites(scope: ConnectionScope) {
      return life.transaction(
        scope,
        (db) =>
          !!db
            .prepare(
              "SELECT 1 FROM chat_summaries WHERE chat_id=? AND generation=? AND level IN ('day','rolling') AND text IS NOT NULL LIMIT 1",
            )
            .get(scope.chatId, scope.generation),
      );
    },
    inputsCurrent(scope: ConnectionScope, ids: readonly number[]) {
      return life.transaction(scope, (db) => historySourcesVisible(db, scope.chatId, ids));
    },
    bounds(scope: ConnectionScope) {
      return life.transaction(
        scope,
        (db) =>
          db
            .prepare(
              `SELECT min(m.timestamp) AS first, max(m.timestamp) AS last, max(m.id) AS cutoff FROM personal_visible_messages m WHERE ${visible}`,
            )
            .get(...parameters(db, scope)) as {
            first: number | null;
            last: number | null;
            cutoff: number | null;
          },
      );
    },
    ids(scope: ConnectionScope, period: SummaryPeriod, cutoff: number) {
      return life.transaction(scope, (db) => {
        const query = db
          .prepare(
            `SELECT m.id FROM personal_visible_messages m WHERE ${visible} AND m.timestamp>=? AND m.timestamp<? AND m.id<=? AND m.id>? ORDER BY m.id LIMIT 512`,
          )
          .pluck();
        const args = [...parameters(db, scope), period.from, period.to, cutoff];
        const ids: number[] = [];
        for (;;) {
          const page = query.all(...args, ids.at(-1) ?? 0) as number[];
          ids.push(...page);
          if (page.length < 512) return ids;
        }
      });
    },
    messages(scope: ConnectionScope, ids: readonly number[]) {
      return life.transaction(
        scope,
        (db) =>
          db
            .prepare(
              `SELECT m.id,m.timestamp,m.author_name AS author,m.text FROM personal_visible_messages m WHERE ${visible} AND m.id IN (SELECT value FROM json_each(?)) ORDER BY m.timestamp,m.id`,
            )
            .all(...parameters(db, scope), JSON.stringify(ids)) as SummaryMessage[],
      );
    },
    entries(scope: ConnectionScope, period: SummaryPeriod, level: SummaryLevel, cutoff: number) {
      return life.transaction(scope, (db) => {
        const rows = db
          .prepare(
            `SELECT ${fields} FROM chat_summaries s WHERE chat_id=? AND generation=? AND level=? AND timezone=? AND starts_at=? AND ends_at=? AND last_id<=? AND text IS NOT NULL ORDER BY id DESC`,
          )
          .all(
            scope.chatId,
            scope.generation,
            level,
            period.timezone,
            period.from,
            period.to,
            cutoff,
          ) as SummaryEntry[];
        return rows.filter((row) => valid(db, scope, row.id));
      });
    },
    sources(scope: ConnectionScope, entry: number) {
      return life.transaction(scope, (db) => (valid(db, scope, entry) ? sourceIds(db, entry) : []));
    },
    current(scope: ConnectionScope, entries: readonly number[]) {
      return life.transaction(scope, (db) => entries.every((id) => valid(db, scope, id)));
    },
    claim(
      scope: ConnectionScope,
      period: SummaryPeriod,
      level: SummaryLevel,
      ids: readonly number[],
      parts: readonly number[],
      now: number,
    ) {
      return life.transaction(scope, (db) => {
        if (
          !ids.length ||
          !historySourcesVisible(db, scope.chatId, ids) ||
          !parts.every((id) => valid(db, scope, id))
        )
          return null;
        const fingerprint = createHash('sha256')
          .update(JSON.stringify([ids, parts]))
          .digest('hex');
        const key = [
          scope.chatId,
          scope.generation,
          level,
          period.timezone,
          period.from,
          period.to,
          fingerprint,
        ];
        const inserted = db
          .prepare(
            'INSERT OR IGNORE INTO chat_summaries(chat_id,generation,level,timezone,starts_at,ends_at,fingerprint,last_id,source_count) VALUES(?,?,?,?,?,?,?,?,?)',
          )
          .run(...key, ids[ids.length - 1], ids.length);
        const row = db
          .prepare(
            `SELECT ${fields} FROM chat_summaries s WHERE chat_id=? AND generation=? AND level=? AND timezone=? AND starts_at=? AND ends_at=? AND fingerprint=?`,
          )
          .get(...key) as Omit<SummaryEntry, 'text'> & { text: string | null };
        if (row.text !== null) return { kind: 'ready' as const, entry: { ...row, text: row.text } };
        if (inserted.changes) {
          db.prepare('INSERT INTO chat_summary_sources SELECT ?,value FROM json_each(?)').run(
            row.id,
            JSON.stringify(ids),
          );
          db.prepare('INSERT INTO chat_summary_parts SELECT ?,value FROM json_each(?)').run(
            row.id,
            JSON.stringify(parts),
          );
        }
        const token = randomUUID();
        const changed = db
          .prepare(
            'UPDATE chat_summaries SET claim=?,claimed_until=? WHERE id=? AND (claim IS NULL OR claimed_until<=?)',
          )
          .run(token, now + 120_000, row.id, now);
        return changed.changes ? { kind: 'owned' as const, id: row.id, token } : null;
      });
    },
    hold(scope: ConnectionScope, id: number, token: string) {
      return life.transaction(
        scope,
        (db) =>
          valid(db, scope, id) &&
          db
            .prepare('UPDATE chat_summaries SET claimed_until=? WHERE id=? AND claim=?')
            .run(Date.now() + 120000, id, token).changes === 1,
      );
    },
    release(scope: ConnectionScope, id: number, token: string) {
      life.transaction(scope, (db) =>
        db
          .prepare(
            'UPDATE chat_summaries SET claimed_until=0,claim=NULL WHERE id=? AND claim=? AND chat_id=? AND generation=?',
          )
          .run(id, token, scope.chatId, scope.generation),
      );
    },
    finish(scope: ConnectionScope, id: number, token: string, text: string | null) {
      return life.transaction(scope, (db) => {
        if (!valid(db, scope, id)) return null;
        const row = db
          .prepare(
            `UPDATE chat_summaries SET text=?,claim=NULL,claimed_until=0 WHERE id=? AND claim=? RETURNING id,level,text,starts_at AS "from",ends_at AS "to",last_id AS lastId,source_count AS count`,
          )
          .get(text, id, token) as SummaryEntry | undefined;
        return text !== null && row ? row : null;
      });
    },
    reserveNotice(scope: ConnectionScope, id: number) {
      return life.transaction(
        scope,
        (db) =>
          historySourcesVisible(db, scope.chatId, [id]) &&
          db.prepare('INSERT OR IGNORE INTO chat_summary_notices(message_id) VALUES(?)').run(id)
            .changes === 1,
      );
    },
    confirmNotice(scope: ConnectionScope, id: number) {
      life.transaction(scope, (db) =>
        db
          .prepare(
            'UPDATE chat_summary_notices SET delivered=1 WHERE message_id=? AND EXISTS(SELECT 1 FROM messages WHERE id=? AND chat_id=?)',
          )
          .run(id, id, scope.chatId),
      );
    },
  };
}
export type ChatSummaryStore = ReturnType<typeof chatSummaryStore>;
