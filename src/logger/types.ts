import type { ConfigErrorCode } from '../config/errors.js';
import type { ConfigParameter } from '../config/types.js';

export type ErrorCategory = 'configuration' | 'type' | 'range' | 'unknown';
export type EventLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export type LogEvent =
  | ({event:'trace_stats';window:'run'} & Readonly<Record<import('../core/response-tracing/metrics.js').TraceEvent,number>>)
  | ({event:'context_stats';window:'run'} & Readonly<Record<'missing_system_prompt'|'static_budget_too_small'|'current_message_too_large'|'internal_error'|'cancelled'|'unavailable'|'deadline_exceeded',number>>)
  | {event:'router_stats';window:'run';senderUnknown:number}
  | ({ event: 'queue_stats'; window: 'run' } & import('../storage/queue-types.js').QueueStats)
  | { event: 'config_loaded' }
  | { event: 'config_invalid'; code: ConfigErrorCode; parameters: readonly ConfigParameter[] }
  | { event: 'component_error'; category: ErrorCategory };

export interface SafeLogger {
  event(event: LogEvent, level?: EventLevel): void;
  componentError(error: unknown): void;
  debugText(text: string): void;
  debugError(error: unknown): void;
}
