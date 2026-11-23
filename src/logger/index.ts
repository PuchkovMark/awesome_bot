import pino from 'pino';
import type { DestinationStream } from 'pino';
import { createRedactor } from '../config/secrets';
import { logLevels } from '../config/types';
import type { LogLevel, Redact } from '../config/types';
import { errorCategory, errorText, ownData, safeEvent } from './sanitize';
import type { EventLevel, SafeLogger } from './types';

export type { LogEvent, SafeLogger } from './types';

export interface LoggerOptions {
  level?: LogLevel;
  redact?: Redact;
  additionalSecrets?: readonly string[];
  destination?: DestinationStream;
}

export function createLogger(options: LoggerOptions = {}): SafeLogger {
  const level = options.level ?? 'info';
  if (!logLevels.includes(level)) throw new TypeError('Invalid log level');
  const sink = pino({ level, base: null }, options.destination ?? process.stdout);
  const additionalRedact = createRedactor(options.additionalSecrets ?? []);
  const redact = (text: string) =>
    (options.redact ?? ((value: string) => value))(additionalRedact(text));
  const eventLevels: readonly EventLevel[] = ['debug', 'info', 'warn', 'error', 'fatal'];
  const event: SafeLogger['event'] = (input, selectedLevel) => {
    const clean = safeEvent(input);
    if (!clean) return;
    const target =
      selectedLevel ??
      (clean.event === 'config_loaded' || clean.event === 'queue_stats' ? 'info' : 'error');
    if (!eventLevels.includes(target)) return;
    sink[target](clean);
  };
  return Object.freeze({
    event,
    componentError(error: unknown) {
      event({ event: 'component_error', category: errorCategory(error) });
    },
    debugText(text: string) {
      if (typeof text === 'string' && sink.isLevelEnabled('debug'))
        sink.debug({ event: 'debug_message', text: redact(text) });
    },
    debugError(error: unknown) {
      if (sink.isLevelEnabled('debug'))
        sink.debug({ event: 'debug_error', text: redact(errorText(error)) });
    },
  });
}

// Диагностика до полной загрузки конфига принимает только безопасные поля.
export function reportConfigError(error: unknown, destination?: DestinationStream): void {
  const candidate = safeEvent({
    event: 'config_invalid',
    code: ownData(error, 'code'),
    parameters: ownData(error, 'parameters'),
  });
  const logger = createLogger(destination ? { level: 'error', destination } : { level: 'error' });
  logger.event(candidate ?? { event: 'config_invalid', code: 'invalid', parameters: [] });
}
