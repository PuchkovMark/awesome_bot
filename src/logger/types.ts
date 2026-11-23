import type { ConfigErrorCode } from '../config/errors';
import type { ConfigParameter } from '../config/types';

export type ErrorCategory = 'configuration' | 'type' | 'range' | 'unknown';
export type EventLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export const applicationFailures = [
  'invalid_arguments', 'storage_failed', 'missing_system_prompt', 'static_budget_too_small',
  'prompt_unreadable', 'prompt_conflict', 'resolution_failed', 'queue_owned', 'queue_failed',
  'vk_failed', 'ready_timeout', 'stop_failed', 'stop_timeout',
] as const;
export type ApplicationFailure = typeof applicationFailures[number];
export type LogEvent =
  | ({event:'trace_stats';window:'run'} & Readonly<Record<import('../core/response-tracing/metrics').TraceEvent,number>>)
  | ({event:'context_stats';window:'run'} & Readonly<Record<'missing_system_prompt'|'static_budget_too_small'|'current_message_too_large'|'internal_error'|'cancelled'|'unavailable'|'deadline_exceeded',number>>)
  | {event:'router_stats';window:'run';senderUnknown:number}
  | {event:'router_silence';reason:'reply_other'|'reply_unknown'|'mention_flood';count:number}
  | ({ event: 'queue_stats'; window: 'run' } & import('../storage/queue-types').QueueStats)
  | { event: 'config_loaded' }
  | { event: 'application_ready' | 'application_stopped' | 'prompt_initialized' | 'chat_resolved' }
  | { event: 'application_failed'; reason: ApplicationFailure }
  | { event: 'config_invalid'; code: ConfigErrorCode; parameters: readonly ConfigParameter[] }
  | { event: 'component_error'; category: ErrorCategory };

export interface SafeLogger {
  event(event: LogEvent, level?: EventLevel): void;
  componentError(error: unknown): void;
  debugText(text: string): void;
  debugError(error: unknown): void;
}
