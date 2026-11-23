import type { Database } from 'better-sqlite3';
import type { ConnectionScope } from '../contracts/index';
import type { ResponseRateConfig } from '../core/chat-limits/response-rate-config';

type ScopeKey = Pick<ConnectionScope, 'chatId' | 'generation'>;

interface FloodState { last: number; id: number | null; silence: number | null }

function state(db: Database, scope: ScopeKey): FloodState | undefined {
  return db.prepare(`SELECT last_mention_at AS last,burst_id AS id,silence_ms AS silence
    FROM mention_flood_state WHERE chat_id=? AND generation=?`)
    .get(scope.chatId, scope.generation) as FloodState | undefined;
}

function active(row: FloodState | undefined, now: number): row is FloodState & { id: number; silence: number } {
  return !!row && row.id !== null && row.silence !== null && now < row.last + row.silence;
}

export function activeMentionFlood(db: Database, scope: ScopeKey, now: number): number | null {
  const row = state(db, scope);
  return active(row, now) ? row.id : null;
}

export function admitMention(db: Database, scope: ScopeKey, messageId: number, config: ResponseRateConfig,
  receivedAt: number): { active: boolean; opened: boolean } {
  const previous = state(db, scope);
  const now = Math.max(receivedAt, previous?.last ?? receivedAt);
  const wasActive = active(previous, now);
  const changed = db.prepare('INSERT INTO mention_flood_inputs VALUES(?,?,?,?) ON CONFLICT DO NOTHING')
    .run(scope.chatId, scope.generation, messageId, now).changes;
  if (!changed) return { active: wasActive, opened: false };

  let opened = false;
  if (!wasActive) {
    const count = db.prepare('SELECT count(*) AS n FROM mention_flood_inputs WHERE chat_id=? AND generation=? AND received_at>? AND received_at<=?')
      .get(scope.chatId, scope.generation, now-config.floodWindowMs, now) as { n: number };
    opened = count.n >= config.floodThreshold;
  }
  const burst = wasActive ? previous.id : opened ? messageId : null;
  const silence = wasActive ? previous.silence : opened ? config.floodWindowMs : null;
  db.prepare(`INSERT INTO mention_flood_state VALUES(?,?,?,?,?)
    ON CONFLICT(chat_id,generation) DO UPDATE SET last_mention_at=excluded.last_mention_at,
    burst_id=excluded.burst_id,silence_ms=excluded.silence_ms`).run(scope.chatId, scope.generation, now, burst, silence);
  return { active: burst !== null, opened };
}

export function pruneMentionFlood(db: Database, now: number, window: number): void {
  db.prepare(`DELETE FROM mention_flood_inputs WHERE rowid IN (
    SELECT rowid FROM mention_flood_inputs WHERE received_at<=? ORDER BY received_at LIMIT 100)`).run(now-window);
}
