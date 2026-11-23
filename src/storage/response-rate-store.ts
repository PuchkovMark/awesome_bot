import type { Database } from 'better-sqlite3';
import type { ConnectionScope } from '../contracts/index';
import { responseRateWindowMs } from '../core/chat-limits/response-rate-config';

type ScopeKey = Pick<ConnectionScope, 'chatId' | 'generation'>;

export type ResponseRateOutcome = 'failed' | 'delivered' | 'unknown';

function rateTime(db: Database, scope: ScopeKey, now: number): number {
  const row = db.prepare('SELECT observed_at AS at FROM response_rate_clock WHERE chat_id=? AND generation=?')
    .get(scope.chatId, scope.generation) as { at: number } | undefined;
  return Math.max(now, row?.at ?? now);
}

export function responseSlotAvailable(db: Database, scope: ScopeKey, limit: number, now: number): boolean {
  const row = db.prepare(`SELECT count(*) AS count FROM response_rate_publications
    WHERE chat_id=? AND generation=? AND (outcome='open' OR started_at>?)`)
    .get(scope.chatId, scope.generation, rateTime(db, scope, now) - responseRateWindowMs) as { count: number };
  return row.count < limit;
}

export function responseAlreadyStarted(db: Database, scope: ScopeKey, key: string): boolean {
  return db.prepare('SELECT 1 FROM response_rate_publications WHERE chat_id=? AND generation=? AND publication_key=?')
    .get(scope.chatId, scope.generation, key) !== undefined;
}

export function noticePeriodAvailable(db:Database,scope:ConnectionScope,now:number):boolean {
 const period=db.prepare('SELECT generation,next_at AS nextAt FROM notice_periods WHERE chat_id=?')
   .get(scope.chatId) as {generation:number;nextAt:number}|undefined;
 return !period||(period.generation===scope.generation&&period.nextAt<=now);
}

/** Вызывается внутри транзакции допуска после всех проверок. */
export function startResponse(db: Database, scope: ScopeKey, key: string, now: number): void {
  const at = rateTime(db, scope, now);
  db.prepare(`INSERT INTO response_rate_clock VALUES(?,?,?)
    ON CONFLICT(chat_id,generation) DO UPDATE SET observed_at=excluded.observed_at`).run(scope.chatId, scope.generation, at);
  db.prepare("INSERT INTO response_rate_publications VALUES(?,?,?,?,'open')").run(scope.chatId, scope.generation, key, at);
}

export function finishResponse(db: Database, scope: ScopeKey, key: string, outcome: ResponseRateOutcome): void {
  if (outcome === 'failed') {
    db.prepare("DELETE FROM response_rate_publications WHERE chat_id=? AND generation=? AND publication_key=? AND outcome='open'")
      .run(scope.chatId, scope.generation, key);
  } else {
    db.prepare("UPDATE response_rate_publications SET outcome=? WHERE chat_id=? AND generation=? AND publication_key=? AND outcome='open'")
      .run(outcome, scope.chatId, scope.generation, key);
  }
}

export function recoverResponseRate(db: Database, prefix: string | null): void {
  db.prepare("UPDATE response_rate_publications SET outcome='unknown' WHERE outcome='open' AND (? IS NULL OR substr(chat_id,1,length(?))=?)")
    .run(prefix, prefix, prefix);
}

export function pruneResponseRate(db: Database, now: number): void {
  db.prepare(`DELETE FROM response_rate_publications WHERE rowid IN (
    SELECT rowid FROM response_rate_publications WHERE outcome<>'open' AND started_at<=?
    ORDER BY started_at LIMIT 100)`).run(now - responseRateWindowMs);
}
