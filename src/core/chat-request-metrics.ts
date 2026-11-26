import type { AuthorizationContext, AuthorizationDecision } from '../contracts/authorization';
import { metricCounters } from '../contracts/chat-metrics';
import type {
  MetricsBucket,
  MetricsGrain,
  MetricsSeries,
  MetricTotals,
} from '../contracts/chat-metrics';
import type { ConnectionScope } from '../contracts/lifecycle';
import { StorageError } from '../storage/errors';

export type ChatMetricsPeriod = 'today' | 'week' | 'month' | 'year';
type Granularity = MetricsGrain | 'month';

export interface ChatMetricsReader {
  read(
    scope: ConnectionScope,
    grain: MetricsGrain,
    from: number,
    through: number,
  ): {
    readonly startedAt: number | null;
    readonly buckets: readonly MetricsBucket[];
  };
}

const hourMs = 3_600_000;
const dayMs = 24 * hourMs;

function firstOfMonth(at: number) {
  const day = new Date(at);
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1);
}

function interval(
  period: ChatMetricsPeriod,
  through: number,
): { from: number; granularity: Granularity } {
  const today = through - (through % dayMs);
  const date = new Date(today);
  switch (period) {
    case 'today':
      return { from: today, granularity: 'hour' };
    case 'week':
      return { from: today - ((date.getUTCDay() + 6) % 7) * dayMs, granularity: 'day' };
    case 'month':
      return { from: firstOfMonth(today), granularity: 'day' };
    case 'year':
      return { from: Date.UTC(date.getUTCFullYear(), 0, 1), granularity: 'month' };
    default:
      throw new TypeError('Некорректный период метрик.');
  }
}

function nextPoint(at: number, granularity: Granularity) {
  if (granularity !== 'month') return at + (granularity === 'hour' ? hourMs : dayMs);
  const month = new Date(at);
  month.setUTCMonth(month.getUTCMonth() + 1);
  return month.getTime();
}

function sum(buckets: readonly MetricsBucket[], ...series: MetricsSeries[]) {
  const totals = Object.fromEntries(metricCounters.map((key) => [key, 0n])) as Record<
    keyof MetricTotals,
    bigint
  >;
  for (const bucket of buckets) {
    if (series.length && !series.includes(bucket.series)) continue;
    for (const key of metricCounters) totals[key] += bucket.totals[key];
  }
  return totals;
}

function duration(totalMs: bigint, count: bigint) {
  return { totalMs, count, averageMs: count ? Number(totalMs) / Number(count) : null };
}

function tokens(totals: MetricTotals) {
  return {
    input: totals.input_tokens,
    output: totals.output_tokens,
    total: totals.input_tokens + totals.output_tokens,
    unknownInput: totals.unknown_input,
    unknownOutput: totals.unknown_output,
    incomplete: totals.unknown_input > 0n || totals.unknown_output > 0n,
  };
}

function model(totals: MetricTotals) {
  return {
    steps: totals.steps,
    attempts: totals.attempts,
    errors: totals.errors,
    tools: totals.tools,
    tokens: tokens(totals),
  };
}

function values(buckets: readonly MetricsBucket[]) {
  const requests = sum(buckets, 'requests');
  const main = sum(buckets, 'main', 'initiative_main');
  const subagents = sum(buckets, 'subagent', 'initiative_subagent');
  const initiative = sum(buckets, 'initiative_main', 'initiative_subagent');
  return {
    requests: requests.requests,
    quotaDenied: requests.quota_denied,
    queueFull: requests.queue_full,
    floodDenied: requests.flood_denied,
    expired: requests.expired,
    interrupted: requests.interrupted,
    waiting: duration(requests.wait_ms, requests.wait_count),
    processing: duration(requests.process_ms, requests.process_count),
    delivery: {
      delivered: requests.delivered,
      partial: requests.partial,
      unknown: requests.unknown_delivery,
      failed: requests.delivery_failed,
    },
    main: { label: 'Основная модель' as const, ...model(main) },
    subagents: {
      label: 'Субагенты' as const,
      ...model(subagents),
      started: subagents.branches_started,
      finished: subagents.branches_finished,
    },
    tokens: tokens(sum(buckets)),
    initiative: { delivered: initiative.delivered, tokens: tokens(initiative) },
    background: {
      tokens: tokens(sum(buckets, 'summary', 'profile_update', 'gate_name', 'gate_initiative')),
      summary: tokens(sum(buckets, 'summary')),
      profileUpdate: tokens(sum(buckets, 'profile_update')),
      groupReplyName: model(sum(buckets, 'gate_name')),
      groupReplyInitiative: model(sum(buckets, 'gate_initiative')),
    },
  };
}

type Values = ReturnType<typeof values>;

export interface ChatMetricsReport {
  readonly period: ChatMetricsPeriod;
  readonly granularity: Granularity;
  readonly from: number;
  readonly through: number;
  readonly startedAt: number | null;
  readonly points: readonly { readonly at: number; readonly values: Values | null }[];
  readonly total: Values | null;
}

export function createChatRequestMetrics(options: {
  readonly authorization: {
    check(context: AuthorizationContext, action: 'usage.read'): Promise<AuthorizationDecision>;
  };
  readonly reader: ChatMetricsReader;
  readonly now?: () => number;
}) {
  return Object.freeze({
    async read(
      context: AuthorizationContext,
      period: ChatMetricsPeriod,
    ): Promise<
      | Exclude<AuthorizationDecision, { allowed: true }>
      | { readonly allowed: true; readonly value: ChatMetricsReport }
    > {
      try {
        const authorization = await options.authorization.check(context, 'usage.read');
        if (!authorization.allowed) return authorization;
        const through = (options.now ?? Date.now)();
        if (!Number.isSafeInteger(through) || through < 0 || through > 8_640_000_000_000_000)
          throw new RangeError('Некорректное время отчёта.');
        const { from, granularity } = interval(period, through);
        const grain = granularity === 'hour' ? 'hour' : 'day';
        const { startedAt, buckets } = options.reader.read(
          context.scope,
          grain,
          Math.max(from, 0),
          through,
        );
        const grouped = new Map<number, MetricsBucket[]>();
        for (const bucket of buckets) {
          const key = granularity === 'month' ? firstOfMonth(bucket.at) : bucket.at;
          const group = grouped.get(key);
          if (group) group.push(bucket);
          else grouped.set(key, [bucket]);
        }
        const points: { at: number; values: Values | null }[] = [];
        const covered = startedAt !== null && startedAt <= through;
        for (let at = from; at <= through;) {
          const end = nextPoint(at, granularity);
          points.push({
            at,
            values: covered && startedAt < end ? values(grouped.get(at) ?? []) : null,
          });
          at = end;
        }
        return {
          allowed: true,
          value: {
            period,
            granularity,
            from,
            through,
            startedAt,
            points,
            total: covered ? values(buckets) : null,
          },
        };
      } catch (error) {
        if (
          error instanceof StorageError &&
          (error.code === 'stale_scope' || error.code === 'uncertain_connection')
        )
          return { allowed: false, code: 'conflict' };
        throw error;
      }
    },
  });
}
