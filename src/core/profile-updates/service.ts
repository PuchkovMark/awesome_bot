import { setTimeout as delay } from 'node:timers/promises';
import type { ChatId, ConnectionScope } from '../../contracts/index';
import type { LlmClient, LlmRequest, LlmResult } from '../../llm/types';
import type { SafeLogger } from '../../logger/types';
import { StorageError } from '../../storage/errors';
import { profileInference } from '../../storage/profile-fact-store';
import { profileUpdateStore } from '../../storage/profile-update-store';
import type { ProfileUpdateSource } from '../../storage/profile-update-intake';
import type { Storage } from '../../storage/types';
import { estimateRequestInput } from '../context/budget';
import { parseProfileUpdates, profileUpdateRequest } from './request';
import { scheduleLlmCall, type LlmAdmission } from '../llm-admission';
import { measureModelCall } from '../model-measurement';

function connectionChanged(error: unknown) {
  return (
    error instanceof StorageError &&
    (error.code === 'stale_scope' || error.code === 'uncertain_connection')
  );
}

async function waitForResponse(pending: Promise<LlmResult>, signal: AbortSignal) {
  const stopped = Promise.withResolvers<null>();
  const abort = () => stopped.resolve(null);
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) abort();
    return await Promise.race([pending, stopped.promise]);
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
  llmAdmission?: LlmAdmission;
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
    const candidates: {
      ids: number[];
      input: number;
      output: number;
      request: LlmRequest;
      portion: readonly ProfileUpdateSource[];
    }[] = [];
    for (let size = sources.length; size > 0; size--) {
      const portion = sources.slice(0, size);
      const request = profileUpdateRequest(portion, session, options.maxOutputTokens, callSignal);
      const input = estimateRequestInput(request);
      const output = request.maxOutputTokens;
      if (input + output <= options.modelContextTokens) {
        candidates.push({ ids: portion.map(({ id }) => id), input, output, request, portion });
      }
    }
    if (!candidates.length || signal.aborted) return;
    const scheduled = await scheduleLlmCall(
      options.llmAdmission,
      { signal: callSignal, current: () => !signal.aborted },
      (send) => {
        const attempt = store.begin(scope, Date.now(), options.group(scope.chatId), candidates);
        if (!attempt) return;
        const meter = store.meter(attempt);
        const { request, portion } = candidates.find(
          ({ ids }) => ids.length === attempt.ids.length,
        )!;
        const pending = send(async () => {
          const response = await measureModelCall(meter, () => options.client.complete(request));
          if ('usage' in response) store.reconcile(attempt, response.usage);
          return response;
        }, meter.cancelBeforeSend);
        return { attempt, portion, pending };
      },
      'background',
    );
    if (scheduled.kind !== 'ready' || !scheduled.value) return;
    const { attempt, portion, pending } = scheduled.value;
    const response = await waitForResponse(pending, callSignal);
    const conclusions =
      !callSignal.aborted && response?.kind === 'complete'
        ? parseProfileUpdates(portion, response.text)
        : null;
    let recorded = 0;
    const accepted = store.finish(
      attempt,
      Date.now(),
      !callSignal.aborted && response?.kind === 'complete',
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
        messages: portion.length,
        attempts: 1,
        recorded,
        outcome: accepted && conclusions ? 'processed' : 'discarded',
      },
      'debug',
    );
  }

  return {
    wake,
    async run() {
      let failure: unknown;
      const unsubscribe = options.llmAdmission?.onRelease(wake);
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
        unsubscribe?.();
        await Promise.all(work.values());
      }
    },
  };
}
