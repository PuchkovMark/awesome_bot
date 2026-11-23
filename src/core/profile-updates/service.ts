import { setTimeout as delay } from 'node:timers/promises';
import type { ChatId, ConnectionScope } from '../../contracts/index';
import type { LlmClient, LlmRequest, LlmResult } from '../../llm/types';
import type { SafeLogger } from '../../logger/types';
import { StorageError } from '../../storage/errors';
import { profileInference } from '../../storage/profile-fact-store';
import { profileUpdateStore } from '../../storage/profile-update-store';
import type { Storage } from '../../storage/types';
import { estimateRequestInput } from '../context/budget';
import { parseProfileUpdates, profileUpdateRequest } from './request';

function connectionChanged(error: unknown) {
  return (
    error instanceof StorageError &&
    (error.code === 'stale_scope' || error.code === 'uncertain_connection')
  );
}

async function invoke(client: LlmClient, request: LlmRequest, signal: AbortSignal) {
  const stopped = Promise.withResolvers<null>();
  const abort = () => stopped.resolve(null);
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) return null;
    return await Promise.race([client.complete(request), stopped.promise]);
  } catch {
    return null;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export function createProfileUpdates(options: {
  storage: Storage;
  logger: SafeLogger;
  client: LlmClient;
  sessionId: (scope: ConnectionScope) => string;
  scope: (chatId: ChatId) => ConnectionScope;
  group: (chatId: ChatId) => boolean;
  signal: AbortSignal;
  modelContextTokens: number;
  maxOutputTokens: number;
}) {
  const { signal } = options;
  const store = profileUpdateStore(options.storage);
  const record = profileInference(options.storage);
  let waiting: AbortController | undefined;
  const work = new Map<ChatId, Promise<void>>();
  const wake = () => waiting?.abort();

  async function process(scope: ConnectionScope) {
    const sources = store.ready(scope, Date.now());
    if (!sources) return;
    const callSignal = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
    const session = options.sessionId(scope);
    const group = options.group(scope.chatId);
    for (let size = sources.length; size > 0 && !signal.aborted; size--) {
      const portion = sources.slice(0, size);
      const request = profileUpdateRequest(portion, session, options.maxOutputTokens, callSignal);
      const input = estimateRequestInput(request);
      const output = request.maxOutputTokens;
      if (input + output > options.modelContextTokens) continue;
      const attempt = store.begin(
        scope,
        portion.map(({ id }) => id),
        Date.now(),
        { group, input, output },
      );
      if (!attempt) continue;

      const response: LlmResult | null = await invoke(options.client, request, callSignal);
      if (response && 'usage' in response) store.reconcile(attempt, response.usage);
      const conclusions =
        !callSignal.aborted && response?.kind === 'complete'
          ? parseProfileUpdates(portion, response.text)
          : null;
      let recorded = 0;
      const accepted = store.finish(
        attempt,
        Date.now(),
        !callSignal.aborted && response !== null && response.kind !== 'error',
        conclusions
          ? () => {
              for (const input of conclusions)
                if (record(scope, input, 'automatic') === 'recorded') recorded++;
            }
          : undefined,
      );
      options.logger.event(
        {
          event: 'profile_update_stats',
          messages: size,
          attempts: 1,
          recorded,
          outcome: accepted && conclusions ? 'processed' : 'discarded',
        },
        'debug',
      );
      return;
    }
  }

  return {
    wake,
    async run() {
      let failure: unknown;
      try {
        while (!signal.aborted) {
          if (failure) throw failure;
          const now = Date.now();
          let wait = 30_000;
          for (const { chatId, generation, dueAt } of store.schedule(now)) {
            if (work.has(chatId)) continue;
            if (dueAt > now) {
              wait = Math.min(wait, dueAt - now);
              continue;
            }
            wait = Math.min(wait, 1_000);
            const task = (async () => {
              const scope = options.scope(chatId);
              if (scope.generation === generation) await process(scope);
            })()
              .catch((error: unknown) => {
                if (!connectionChanged(error)) {
                  failure = error;
                  wake();
                }
              })
              .finally(() => work.delete(chatId));
            work.set(chatId, task);
          }
          waiting = new AbortController();
          try {
            await delay(wait, undefined, { signal: AbortSignal.any([signal, waiting.signal]) });
          } catch (error) {
            if (!signal.aborted && !waiting.signal.aborted) throw error;
          } finally {
            waiting = undefined;
          }
        }
      } finally {
        await Promise.all(work.values());
      }
    },
  };
}
