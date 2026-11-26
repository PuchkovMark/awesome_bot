import { setTimeout as delay } from 'node:timers/promises';
import { VkApiError, vkCursor } from './api';
import type { VkApi } from './api';
import { waitForVkRead } from './rate-limit';
import { vkRecord } from './normalize';

const waitSeconds = 25;
const accessDenied = new Set([5, 7, 15, 27]);

export type VkPollGap =
  'startup' | 'lost_position' | 'renew_server' | 'invalid_response' | 'transport_error';

interface VkPollListener {
  readonly onGap: (reason: VkPollGap) => Promise<void>;
  readonly onUpdates: (updates: readonly unknown[]) => void | Promise<boolean>;
  readonly onResume?: (position: 'previous_position' | 'new_position') => void;
  readonly onReady?: () => void;
}

export interface VkPollTransport {
  run(listener: VkPollListener, signal: AbortSignal): Promise<void>;
}

export class VkPollError extends Error {
  readonly code: 'access_denied' | 'unsafe_server';
  readonly vkCode: number | undefined;
  constructor(code: VkPollError['code'], vkCode?: number) {
    super(`VK Long Poll: ${code}`);
    this.name = 'VkPollError';
    this.code = code;
    this.vkCode = vkCode;
  }
}

function serverUrl(server: string): URL {
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    throw new VkPollError('unsafe_server');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !['vk.com', 'vk.ru', 'vk.me'].some(
      (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`),
    )
  ) {
    throw new VkPollError('unsafe_server');
  }
  url.hash = '';
  return url;
}

export function createVkLongPoll(options: {
  readonly api: Pick<VkApi, 'getLongPollServer'>;
  readonly fetch?: typeof fetch;
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}): VkPollTransport {
  const request = options.fetch ?? fetch;
  const wait = options.wait ?? ((ms, signal) => delay(ms, undefined, { signal }));

  return Object.freeze({
    async run(listener: VkPollListener, signal: AbortSignal): Promise<void> {
      if (signal.aborted) return;
      let backoff = 250;
      let ready = false;
      let lastGap: VkPollGap | undefined;
      let retryCursor: string | undefined;
      let consecutiveReadErrors = 0;
      let resume: 'new_position' | 'previous_position' | undefined = 'new_position';
      let session: { url: URL; key: string; cursor: string } | undefined;

      async function retry() {
        try {
          await wait(backoff, signal);
        } catch {
          if (!signal.aborted) throw new Error('VK Long Poll: retry interrupted');
        }
        backoff = Math.min(30_000, backoff * 2);
      }

      async function gap(reason: VkPollGap) {
        if (lastGap !== reason) {
          lastGap = reason;
          await listener.onGap(reason);
        }
      }

      await gap('startup');
      while (!signal.aborted) {
        if (!session) {
          try {
            const server = await waitForVkRead(options.api.getLongPollServer(signal), signal);
            session = {
              url: serverUrl(server.server),
              key: server.key,
              cursor: retryCursor ?? server.ts,
            };
            retryCursor = undefined;
          } catch (error) {
            if (signal.aborted) return;
            if (error instanceof VkPollError) throw error;
            if (
              error instanceof VkApiError &&
              error.code !== undefined &&
              accessDenied.has(error.code)
            ) {
              throw new VkPollError('access_denied', error.code);
            }
            await gap('transport_error');
            await retry();
            continue;
          }
        }

        if (signal.aborted) return;
        const query = new URL(session.url);
        query.searchParams.set('act', 'a_check');
        query.searchParams.set('key', session.key);
        query.searchParams.set('ts', session.cursor);
        query.searchParams.set('wait', String(waitSeconds));
        let page: Record<string, unknown> | undefined;
        try {
          const response = await request(query, {
            redirect: 'error',
            signal: AbortSignal.any([signal, AbortSignal.timeout((waitSeconds + 5) * 1000)]),
          });
          if (response.status === 401 || response.status === 403)
            throw new VkPollError('access_denied');
          if (!response.ok) throw new Error('poll_http_failure');
          page = vkRecord(await response.json());
        } catch (error) {
          if (signal.aborted) return;
          await gap('transport_error');
          if (error instanceof VkPollError) throw error;
          resume ??= 'previous_position';
          if (++consecutiveReadErrors >= 3) {
            retryCursor = session.cursor;
            session = undefined;
            consecutiveReadErrors = 0;
          }
          await retry();
          continue;
        }
        if (signal.aborted) return;

        const next = vkCursor(page?.ts);
        if (page?.failed === undefined && next !== undefined && Array.isArray(page?.updates)) {
          if (!ready) {
            ready = true;
            listener.onReady?.();
          }
          if (signal.aborted) return;
          if (resume) listener.onResume?.(resume);
          resume = undefined;
          if ((await listener.onUpdates(page.updates)) === false) {
            await gap('transport_error');
            resume = 'previous_position';
            await retry();
            continue;
          }
          session.cursor = next;
          consecutiveReadErrors = 0;
          backoff = 250;
          lastGap = undefined;
          continue;
        }
        if (page?.failed === 1 && next !== undefined && next !== session.cursor) {
          await gap('lost_position');
          resume = 'new_position';
          session.cursor = next;
          continue;
        }
        if (page?.failed === 2) {
          retryCursor = session.cursor;
          await gap('transport_error');
          resume ??= 'previous_position';
          session = undefined;
          await retry();
          continue;
        }
        const lost = page?.failed === 3 || page?.failed === 1;
        await gap(lost ? 'renew_server' : 'invalid_response');
        if (lost) resume = 'new_position';
        else {
          retryCursor = session.cursor;
          resume ??= 'previous_position';
        }
        session = undefined;
        await retry();
      }
    },
  });
}
