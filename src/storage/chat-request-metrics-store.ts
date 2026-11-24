import type { Database } from 'better-sqlite3';
import { metricCounters } from '../contracts/chat-metrics';
import type {
  MetricDelta,
  MetricsBucket,
  MetricsGrain,
  MetricsScope,
  MetricsSeries,
  MetricTotals,
} from '../contracts/chat-metrics';
import type { ConnectionScope } from '../contracts/index';
import { requireInput, timestamp } from './validation';

const hourMs = 3_600_000;
const dayMs = 24 * hourMs;
const batchSize = 200;

function floor(at: number, interval: number) {
  return at - (at % interval);
}

export function metricsRetention(now: number) {
  const month = new Date(now);
  month.setUTCDate(1);
  month.setUTCHours(0, 0, 0, 0);
  month.setUTCMonth(month.getUTCMonth() - 11);
  return { day: Math.max(0, month.getTime()), hour: floor(now, dayMs) };
}

function collection(db: Database, { chatId, generation }: MetricsScope) {
  return db
    .prepare('SELECT started_at FROM chat_metrics_collection WHERE chat_id=? AND generation=?')
    .pluck()
    .get(chatId, generation) as number | undefined;
}

function collected(db: Database, scope: MetricsScope, at: number, now: number) {
  const start = collection(db, scope);
  return start !== undefined && at >= start && at >= metricsRetention(now).day;
}

export function addChatMetrics(
  db: Database,
  scope: MetricsScope,
  at: number,
  series: MetricsSeries,
  delta: MetricDelta,
  now = Date.now(),
): boolean {
  requireInput(db.inTransaction);
  timestamp(at);
  timestamp(now);
  if (!collected(db, scope, at, now)) return false;

  const keys = metricCounters.filter((key) => delta[key] !== undefined);
  if (!keys.length) return false;
  const values = keys.map((key) => delta[key]!);
  const upsert = db.prepare(
    `INSERT INTO chat_metrics_buckets(chat_id,generation,grain,bucket_at,series,${keys.join(',')})
     VALUES(?,?,?,?,?,${keys.map(() => '?').join(',')})
     ON CONFLICT(chat_id,generation,grain,bucket_at,series) DO UPDATE SET
     ${keys.map((key) => `${key}=min(9223372036854775807,${key}+excluded.${key})`).join(',')}`,
  );
  const day = floor(at, dayMs);
  upsert.run(scope.chatId, scope.generation, 'day', day, series, ...values);
  if (day === floor(now, dayMs))
    upsert.run(scope.chatId, scope.generation, 'hour', floor(at, hourMs), series, ...values);
  return true;
}

export function recordChatMetric(
  db: Database,
  scope: MetricsScope,
  jobId: number,
  key: string,
  at: number,
  series: MetricsSeries,
  delta: MetricDelta,
  now = Date.now(),
): boolean {
  requireInput(db.inTransaction);
  if (!collected(db, scope, at, now)) return false;
  const inserted = db
    .prepare(
      `INSERT INTO chat_metrics_job_events(job_id,event_key)
       SELECT id,? FROM queue_jobs WHERE id=? AND chat_id=? AND generation=? AND state='running'
       ON CONFLICT DO NOTHING`,
    )
    .run(key, jobId, scope.chatId, scope.generation).changes;
  return inserted === 1 && addChatMetrics(db, scope, at, series, delta, now);
}

export function pruneChatMetrics(db: Database, now: number): void {
  requireInput(db.inTransaction);
  const { hour, day } = metricsRetention(now);
  const bucket = db.prepare(
    `DELETE FROM chat_metrics_buckets WHERE rowid IN (
       SELECT rowid FROM chat_metrics_buckets WHERE grain=? AND bucket_at<?
       ORDER BY bucket_at LIMIT ?)`,
  );
  bucket.run('hour', hour, batchSize);
  bucket.run('day', day, batchSize);
  db.prepare(
    `DELETE FROM chat_metrics_attempts WHERE rowid IN (
       SELECT rowid FROM chat_metrics_attempts WHERE admitted_at<? ORDER BY admitted_at LIMIT ?)`,
  ).run(day, batchSize);
  db.prepare(
    `DELETE FROM chat_metrics_publications WHERE job_id IN (
       SELECT job_id FROM chat_metrics_publications WHERE received_at<? ORDER BY received_at LIMIT ?)`,
  ).run(day, batchSize);
}

export function createChatRequestMetricsStore(
  transaction: <T>(scope: ConnectionScope, operation: (db: Database) => T) => T,
) {
  return Object.freeze({
    read(scope: ConnectionScope, grain: MetricsGrain, from: number, through: number) {
      timestamp(from);
      timestamp(through);
      requireInput(grain === 'hour' || grain === 'day');
      return transaction(scope, (db) => {
        const startedAt = collection(db, scope) ?? null;
        const bounds = metricsRetention(through);
        const rows = db
          .prepare(
            `SELECT bucket_at AS at,series,${metricCounters.join(',')}
             FROM chat_metrics_buckets WHERE chat_id=? AND generation=? AND grain=?
             AND bucket_at>=? AND bucket_at<=? ORDER BY bucket_at,series`,
          )
          .safeIntegers()
          .all(
            scope.chatId,
            scope.generation,
            grain,
            Math.max(from, bounds[grain]),
            through,
          ) as (MetricTotals & { at: bigint; series: MetricsSeries })[];
        const buckets: readonly MetricsBucket[] = rows.map(({ at, series, ...totals }) => ({
          at: Number(at),
          series,
          totals,
        }));
        return { startedAt, buckets };
      });
    },
  });
}

const stores = new WeakMap<object, ReturnType<typeof createChatRequestMetricsStore>>();

export function registerChatRequestMetrics(
  storage: object,
  store: ReturnType<typeof createChatRequestMetricsStore>,
) {
  stores.set(storage, store);
}

export function chatRequestMetricsStore(storage: object) {
  const store = stores.get(storage);
  requireInput(store);
  return store;
}
