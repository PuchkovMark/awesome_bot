import type { ConfigErrorCode } from '../config/errors.js';
import type { ConfigParameter } from '../config/types.js';

export type ErrorCategory = 'configuration' | 'type' | 'range' | 'unknown';
export type EventLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export type LogEvent =
  | { event: 'config_loaded' }
  | { event: 'config_invalid'; code: ConfigErrorCode; parameters: readonly ConfigParameter[] }
  | { event: 'component_error'; category: ErrorCategory };

export interface SafeLogger {
  event(event: LogEvent, level?: EventLevel): void;
  componentError(error: unknown): void;
  debugText(text: string): void;
  debugError(error: unknown): void;
}
