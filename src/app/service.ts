import { createVkChannel } from '../channels/index.js';
import type { ApplicationConfig } from '../config/application.js';
import {
  createAgentLoopQueue, createAuthorizationService, createContextPreparation, createLifecycleService,
  createMessageRouter, createPublicationService, QueueError,
} from '../core/index.js';
import type { ChatQueue } from '../core/index.js';
import { createLlmClient, createLlmSessionId } from '../llm/index.js';
import type { LlmClient } from '../llm/index.js';
import type { SafeLogger } from '../logger/index.js';
import type { ApplicationFailure } from '../logger/types.js';
import { catalogAdministration } from '../storage/catalog-admin.js';
import { openStorage } from '../storage/index.js';
import type { Storage } from '../storage/index.js';
import { unconfirmedLifecycleSource } from './setup.js';

interface ApplicationDependencies {
  readonly vk?: Parameters<typeof createVkChannel>[1];
  readonly client?: LlmClient;
  readonly readyTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
}

export async function runApplication(config: ApplicationConfig, logger: SafeLogger, externalSignal: AbortSignal,
  dependencies: ApplicationDependencies = {}): Promise<ApplicationFailure | null> {
  const controller = new AbortController();
  const signal = controller.signal;
  const stopping = Promise.withResolvers<void>();
  const deadline = Promise.withResolvers<'stop_timeout'>();
  let reason: ApplicationFailure | null = null;
  let storage: Storage | undefined;
  let authorization: Awaited<ReturnType<typeof createAuthorizationService>> | undefined;
  let queue: ChatQueue | undefined;
  let poll: Promise<void> | undefined;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  const typing = new Set<Promise<void>>();

  function stop(failure: ApplicationFailure | null) {
    if (signal.aborted) return;
    reason = failure;
    stopTimer = setTimeout(() => deadline.resolve('stop_timeout'), dependencies.stopTimeoutMs ?? 15_000);
    clearTimeout(readyTimer);
    controller.abort();
    stopping.resolve();
  }

  const stopFromSignal = () => stop(null);
  externalSignal.addEventListener('abort', stopFromSignal, { once: true });
  if (externalSignal.aborted) stopFromSignal();

  const startup = (async () => {
    let startupFailure: ApplicationFailure = 'storage_failed';
    try {
      if (signal.aborted) return;
      storage = await openStorage(config.databasePath, { versioning: config.versioning });
      if (signal.aborted) return;
      const lifecycle = createLifecycleService({
        storage, ownerId: config.authorization.ownerId, source: unconfirmedLifecycleSource,
      });
      let ready = false;
      const channel = createVkChannel({
        ...config.vk, lifecycle, chats: storage.chats, signal,
        onReady() {
          if (signal.aborted || ready) return;
          ready = true;
          clearTimeout(readyTimer);
          logger.event({ event: 'application_ready' }, 'info');
        },
      }, dependencies.vk);
      const preparation = createContextPreparation({
        storage, config: config.context, logger, sessionId: createLlmSessionId(config.sessionSecret),
        capabilities: ({ chatId }) => channel.capabilities({ chatId }),
      });
      const contextFailure = preparation.checkStartup(await catalogAdministration(storage).systemPrompt());
      if (contextFailure) { stop(contextFailure); return; }
      if (signal.aborted) return;
      authorization = await createAuthorizationService({ config: config.authorization, store: storage.authorization });
      if (signal.aborted) return;

      startupFailure = 'queue_failed';
      const publication = createPublicationService({ storage, port: channel.publicationPort });
      queue = createAgentLoopQueue({
        storage, logger, modelName: config.llm.model, tracing: config.tracing,
        client: dependencies.client ?? createLlmClient(config.llm),
        platform: channel.platform, signal,
        preparationTimeoutMs: preparation.config.preparationTimeoutMs,
        postPreparationMarginMs: preparation.config.postPreparationMarginMs,
        prepare(work) {
          const operation = channel.sendTypingForWork(work.scope, work).finally(() => typing.delete(operation));
          typing.add(operation);
          return preparation.prepare(work);
        },
        onSettled: publication.onSettled,
      });
      queue.signal.addEventListener('abort', () => stop('queue_failed'), { once: true });
      await queue.start();
      if (signal.aborted) return;

      startupFailure = 'vk_failed';
      const router = createMessageRouter({ storage, queue, logger, authorization, onQueueFull: publication.queueFull });
      readyTimer = setTimeout(() => stop('ready_timeout'), dependencies.readyTimeoutMs ?? 45_000);
      poll = channel.startRouted(router).then(
        () => { if (!signal.aborted) stop('vk_failed'); },
        () => stop('vk_failed'),
      );
    } catch (error) {
      stop(error instanceof QueueError && error.code === 'owned' ? 'queue_owned' : startupFailure);
    }
  })();

  const cleanup = (async () => {
    await stopping.promise;
    await startup;
    const results = await Promise.allSettled([queue?.stop(), poll, ...typing]);
    authorization?.dispose();
    try { await storage?.close(); }
    catch { return reason ?? 'stop_failed'; }
    return reason ?? (results.some(result => result.status === 'rejected') ? 'stop_failed' : null);
  })();

  try { return await Promise.race([cleanup, deadline.promise]); }
  finally {
    clearTimeout(stopTimer);
    externalSignal.removeEventListener('abort', stopFromSignal);
  }
}
