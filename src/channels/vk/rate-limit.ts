import { setTimeout as delay } from 'node:timers/promises';

const intervalMs = 50;

export interface VkRequestGuard {
  readonly signal?: AbortSignal;
  readonly isCurrent?: () => boolean;
  readonly allow?: () => boolean | Promise<boolean>;
  readonly beforeSend?: () => boolean;
}

export class VkRequestCancelled extends Error {
  constructor() {
    super('VK request cancelled before dispatch');
    this.name = 'VkRequestCancelled';
  }
}

type Wait = (ms: number, signal?: AbortSignal) => Promise<unknown>;

export function createVkRateLimiter(options: {
  readonly now?: () => number;
  readonly wait?: Wait;
} = {}) {
  const now = options.now ?? (() => performance.now());
  const wait: Wait = options.wait ?? ((ms, signal) => delay(ms, undefined, signal ? { signal } : undefined));
  let nextAt = Number.NEGATIVE_INFINITY;
  let tail = Promise.resolve();

  return function run<T>(call: () => Promise<T>, { signal, isCurrent, allow, beforeSend }: VkRequestGuard = {}): Promise<T> {
    if (signal?.aborted) return Promise.reject(new VkRequestCancelled());
    const result = Promise.withResolvers<T>();
    const abort = () => result.reject(new VkRequestCancelled());
    signal?.addEventListener('abort', abort, { once: true });

    const turn = tail.then(async () => {
      try {
        if (signal?.aborted) throw new VkRequestCancelled();
        let remaining = nextAt - now();
        while (remaining > 0) {
          await wait(Math.ceil(remaining), signal);
          remaining = nextAt - now();
        }
        if ((allow && !await Promise.race([allow(), result.promise.then(() => false, () => false)]))
          || signal?.aborted || (isCurrent && !isCurrent()) || (beforeSend && !beforeSend())) throw new VkRequestCancelled();
      } catch {
        result.reject(new VkRequestCancelled());
        return;
      } finally {
        signal?.removeEventListener('abort', abort);
      }

      nextAt = now() + intervalMs;
      result.resolve(call());
    });
    // Ограничивается запуск запросов. Ожидание ответа не держит очередь лимитера.
    tail = turn.catch(error => { result.reject(error); });
    return result.promise;
  };
}

export async function waitForVkRetry(retry: number, signal?: AbortSignal): Promise<void> {
  try {
    await delay(150 * 2 ** retry, undefined, signal ? { signal } : undefined);
  } catch {
    throw new VkRequestCancelled();
  }
}
