import { expect, test } from 'vitest';
import { queueConfig } from '../src/core/chat-queue/validation.js';
test('срок обработчика выводится из срока цикла с запасом, снимок неизменяемый', () => {
  expect(queueConfig()).toMatchObject({ maxQueuedTotal: 8, maxQueuedPerChat: 2, maxQueueAgeMs: 600000, handlerTimeoutMs: 130000 });
  const input = { loopTimeoutMs: 200000 }; const result = queueConfig(input); input.loopTimeoutMs = 1;
  expect(result.handlerTimeoutMs).toBe(210000); expect(Object.isFrozen(result)).toBe(true);
});
test.each([{ handlerTimeoutMs: 120000 }, { loopTimeoutMs: 200000, handlerTimeoutMs: 130000 }, { maxQueuedTotal: 0 },
  { leaseMs: 5, renewIntervalMs: 5 }, { handlerMarginMs: -1 }, { loopTimeoutMs: 2147483647 }, { maxQueueAgeMs: 1.5 }])('отказ несовместимой конфигурации %j', input => { expect(() => queueConfig(input)).toThrow('invalid_input'); });

test('счётчики проецируются без текстов, идентификаторов и геттеров', async () => {
  const { safeEvent } = await import('../src/logger/sanitize.js');
  const source = { event: 'queue_stats', window: 'run', depthQueued: 1, depthRunning: 0,
    waitCount: 1, waitTotalMs: 2, waitMaxMs: 2, rejected: 3, expired: 4, interrupted: 5, chatId: 'private', text: 'private' };
  Object.defineProperty(source, 'toJSON', { get() { throw Error('private'); } });
  const clean = safeEvent(source);
  expect(clean).toEqual({ event: 'queue_stats', window: 'run', depthQueued: 1, depthRunning: 0,
    waitCount: 1, waitTotalMs: 2, waitMaxMs: 2, rejected: 3, expired: 4, interrupted: 5 });
  expect(safeEvent({ ...source, depthQueued: -1 })).toBeUndefined();
  Object.defineProperty(source, 'depthQueued', { get() { throw Error('private'); } });
  expect(safeEvent(source)).toBeUndefined();
});
