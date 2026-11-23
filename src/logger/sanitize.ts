import { ConfigError, configErrorCodes } from '../config/errors';
import { configParameters } from '../config/types';
import { applicationFailures } from './types';
import type { ErrorCategory, LogEvent } from './types';

// Не читать геттеры, не вызывать toJSON и не передавать исходный объект сериализатору.
export function ownData(object: unknown, key: string): unknown {
  if (typeof object !== 'object' || object === null) return undefined;
  try {
    return Object.getOwnPropertyDescriptor(object, key)?.value;
  } catch {
    return undefined;
  }
}

export function safeEvent(input: unknown): LogEvent | undefined {
  const event = ownData(input, 'event');
  if (event === 'trace_stats' && ownData(input, 'window') === 'run') {
    const keys = [
      'full_write_failed',
      'size_exceeded',
      'minimal_saved',
      'trace_write_failed',
    ] as const;
    const fields = Object.fromEntries(keys.map((k) => [k, ownData(input, k)]));
    if (keys.every((k) => Number.isSafeInteger(fields[k]) && (fields[k] as number) >= 0))
      return { event, window: 'run', ...fields } as LogEvent;
  }
  if (event === 'context_stats' && ownData(input, 'window') === 'run') {
    const keys = [
      'missing_system_prompt',
      'static_budget_too_small',
      'current_message_too_large',
      'internal_error',
      'cancelled',
      'unavailable',
      'deadline_exceeded',
    ] as const;
    const fields = Object.fromEntries(keys.map((key) => [key, ownData(input, key)]));
    if (keys.every((key) => Number.isSafeInteger(fields[key]) && (fields[key] as number) >= 0))
      return { event, window: 'run', ...fields } as LogEvent;
  }
  if (event === 'router_silence') {
    const reason = ownData(input, 'reason'),
      count = ownData(input, 'count');
    if (
      (reason === 'reply_other' || reason === 'reply_unknown' || reason === 'mention_flood') &&
      typeof count === 'number' &&
      Number.isSafeInteger(count) &&
      count >= 0
    )
      return { event, reason, count };
  }
  if (event === 'router_stats' && ownData(input, 'window') === 'run') {
    const n = ownData(input, 'senderUnknown');
    if (Number.isSafeInteger(n) && (n as number) >= 0)
      return { event, window: 'run', senderUnknown: n as number };
  }
  if (event === 'queue_stats' && ownData(input, 'window') === 'run') {
    const keys = [
      'depthQueued',
      'depthRunning',
      'waitCount',
      'waitTotalMs',
      'waitMaxMs',
      'rejected',
      'expired',
      'interrupted',
    ] as const;
    const fields = Object.fromEntries(keys.map((key) => [key, ownData(input, key)]));
    if (keys.every((key) => Number.isSafeInteger(fields[key]) && (fields[key] as number) >= 0)) {
      return { event, window: 'run', ...fields } as LogEvent;
    }
  }
  if (event === 'profile_update_stats') {
    const messages = ownData(input, 'messages'),
      attempts = ownData(input, 'attempts'),
      recorded = ownData(input, 'recorded'),
      outcome = ownData(input, 'outcome');
    if (
      typeof messages === 'number' &&
      Number.isSafeInteger(messages) &&
      messages > 0 &&
      attempts === 1 &&
      typeof recorded === 'number' &&
      Number.isSafeInteger(recorded) &&
      recorded >= 0 &&
      recorded <= messages &&
      (outcome === 'processed' || outcome === 'discarded')
    )
      return { event, messages, attempts, recorded, outcome };
  }
  if (event === 'config_loaded') return { event };
  if (
    event === 'application_ready' ||
    event === 'application_stopped' ||
    event === 'prompt_initialized' ||
    event === 'chat_resolved'
  )
    return { event };
  if (event === 'application_failed') {
    const reason = applicationFailures.find((candidate) => candidate === ownData(input, 'reason'));
    if (reason) return { event, reason };
  }
  if (event === 'component_error') {
    const category = ownData(input, 'category');
    if (
      category === 'configuration' ||
      category === 'type' ||
      category === 'range' ||
      category === 'unknown'
    ) {
      return { event, category };
    }
  }
  if (event === 'config_invalid') {
    const code = ownData(input, 'code');
    if (!configErrorCodes.some((candidate) => candidate === code)) return undefined;
    const inputParameters = ownData(input, 'parameters');
    const supplied = new Set<unknown>();
    if (Array.isArray(inputParameters)) {
      // Перечисляем только собственные data-поля, не вызывая методы переданного массива.
      try {
        for (const [key, descriptor] of Object.entries(
          Object.getOwnPropertyDescriptors(inputParameters),
        )) {
          if (/^(0|[1-9]\d*)$/.test(key) && 'value' in descriptor) supplied.add(descriptor.value);
        }
      } catch {
        /* Недоступные поля не включаются в событие. */
      }
    }
    return {
      event,
      code: code as (typeof configErrorCodes)[number],
      parameters: configParameters.filter((parameter) => supplied.has(parameter)),
    };
  }
  return undefined;
}

export function errorCategory(error: unknown): ErrorCategory {
  try {
    if (error instanceof ConfigError) return 'configuration';
    if (error instanceof TypeError) return 'type';
    if (error instanceof RangeError) return 'range';
  } catch {
    /* Не исследуем недоверенный прототип. */
  }
  return 'unknown';
}

export function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  const values = [ownData(error, 'message'), ownData(error, 'stack')];
  const cause = ownData(error, 'cause');
  values.push(typeof cause === 'string' ? cause : ownData(cause, 'message'));
  return values.filter((value): value is string => typeof value === 'string').join('\n');
}
