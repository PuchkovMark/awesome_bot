import type { Database } from 'better-sqlite3';
import type { ChatLimits } from '../core/chat-limits/config';
import type { UserId } from '../contracts/index';
import type { QueueWork } from './queue-types';
import { timestamp } from './validation';

export function admitRequestQuota(db: Database, work: QueueWork, limits: ChatLimits, now: number) {
  timestamp(now);
  const { id, scope, messageId } = work;
  if (db.prepare('SELECT 1 FROM request_quota_admissions WHERE job_id=?').get(id)) return true;

  const source = db.prepare(`SELECT user_id AS userId FROM messages
    WHERE id=? AND chat_id=? AND role='user' AND purpose='conversation'`).get(messageId, scope.chatId) as { userId: UserId } | undefined;
  if (!source) return false;

  const total = db.prepare(`SELECT count(*) AS n FROM request_quota_admissions
    WHERE chat_id=? AND generation=? AND admitted_at>? AND admitted_at<=?`)
    .get(scope.chatId, scope.generation, now - limits.chatWindowMs, now) as { n: number };
  const byUser = db.prepare(`SELECT count(*) AS n FROM request_quota_admissions
    WHERE chat_id=? AND generation=? AND user_id=? AND admitted_at>? AND admitted_at<=?`)
    .get(scope.chatId, scope.generation, source.userId, now - limits.userWindowMs, now) as { n: number };
  if (total.n >= limits.chatRequests || byUser.n >= limits.userRequests) return 'quota_exhausted' as const;

  db.prepare(`INSERT INTO request_quota_admissions(job_id,chat_id,generation,user_id,admitted_at) VALUES(?,?,?,?,?)`)
    .run(id, scope.chatId, scope.generation, source.userId, now);
  return true;
}

export function pruneRequestQuota(db: Database, limits: ChatLimits, now: number, prefix: string | null) {
  const cutoff = now - Math.max(limits.userWindowMs, limits.chatWindowMs);
  return db.prepare(`DELETE FROM request_quota_admissions WHERE job_id IN (
    SELECT a.job_id FROM request_quota_admissions a
    WHERE a.admitted_at<=? AND (? IS NULL OR substr(a.chat_id,1,length(?))=?)
      AND NOT EXISTS(SELECT 1 FROM queue_jobs j WHERE j.id=a.job_id AND j.state='running')
    ORDER BY a.admitted_at, a.job_id LIMIT 100)`).run(cutoff, prefix, prefix, prefix).changes;
}
