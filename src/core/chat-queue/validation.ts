import type { QueueConfig } from './types';
import { QueueError } from './errors';
export function queueConfig(input: Partial<QueueConfig> = {}): QueueConfig {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error();
    const defaults: QueueConfig = {
      maxConcurrentChats: 4,
      maxQueuedPerChat: 2,
      maxQueuedTotal: 8,
      maxQueueAgeMs: 600000,
      loopTimeoutMs: 120000,
      handlerMarginMs: 10000,
      handlerTimeoutMs: 130000,
      leaseMs: 30000,
      renewIntervalMs: 10000,
      stopTimeoutMs: 10000,
    };
    if (Reflect.ownKeys(input).some((k) => typeof k !== 'string' || !Object.hasOwn(defaults, k)))
      throw Error();
    const config = { ...defaults, ...input };
    if (input.handlerTimeoutMs === undefined)
      config.handlerTimeoutMs = config.loopTimeoutMs + config.handlerMarginMs;
    if (Object.values(config).some((v) => !Number.isSafeInteger(v) || v <= 0 || v > 2147483647))
      throw Error();
    if (
      config.handlerTimeoutMs < config.loopTimeoutMs + config.handlerMarginMs ||
      config.renewIntervalMs >= config.leaseMs
    )
      throw Error();
    return Object.freeze(config);
  } catch {
    throw new QueueError('invalid_input');
  }
}
