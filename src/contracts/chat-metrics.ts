import type { ConnectionScope } from './lifecycle';

export type MetricsScope = Pick<ConnectionScope, 'chatId' | 'generation'>;
export type MetricsGrain = 'hour' | 'day';
export type MetricsSeries =
  | 'requests'
  | 'main'
  | 'subagent'
  | 'initiative_main'
  | 'initiative_subagent'
  | 'summary'
  | 'profile_update';

export const metricCounters = [
  'requests',
  'quota_denied',
  'queue_full',
  'flood_denied',
  'expired',
  'interrupted',
  'wait_ms',
  'wait_count',
  'process_ms',
  'process_count',
  'delivered',
  'partial',
  'unknown_delivery',
  'delivery_failed',
  'steps',
  'attempts',
  'errors',
  'tools',
  'branches_started',
  'branches_finished',
  'input_tokens',
  'output_tokens',
  'unknown_input',
  'unknown_output',
] as const;

type MetricCounter = (typeof metricCounters)[number];
export type MetricTotals = Readonly<Record<MetricCounter, bigint>>;
export type MetricDelta = Partial<Record<MetricCounter, number | bigint>>;

export interface MetricsBucket {
  readonly at: number;
  readonly series: MetricsSeries;
  readonly totals: MetricTotals;
}
