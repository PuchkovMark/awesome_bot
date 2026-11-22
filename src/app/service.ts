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
import { createChatOnboarding } from '../core/chat-onboarding/service.js';
import { canonicalTimezone, parseTimezoneCommand } from '../core/chat-onboarding/timezone.js';
import { vkLocalId } from '../channels/vk/outbound.js';
import { describeVkRights } from '../channels/vk/introduction.js';
import { isVkGroupChat } from '../channels/vk/normalize.js';
import type { ConnectionScope } from '../contracts/index.js';

interface ApplicationDependencies {
  readonly vk?: Parameters<typeof createVkChannel>[1];
  readonly client?: LlmClient;
  readonly readyTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  readonly onboardingIntervalMs?: number;
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
  let introductionWork: Promise<void> | undefined;
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
        ...config.vk, lifecycle, chats: storage.chats, signal, owner: config.authorization.ownerId,
        captureDisclosure: scope => onboarding.capture(scope),
        onReady() {
          if (signal.aborted || ready) return;
          ready = true;
          clearTimeout(readyTimer);
          logger.event({ event: 'application_ready' }, 'info');
          introductionWork = onboarding.run().catch(() => stop('vk_failed'));
        },
      }, dependencies.vk);
      const group = (chatId: ConnectionScope['chatId']) => {
        const local = vkLocalId(chatId);
        return local !== undefined && isVkGroupChat(local);
      };
      const onboarding = createChatOnboarding({storage,lifecycle,port:channel.introduction!,signal,
        provider:'OpenCode Go',describeRights:describeVkRights,groups:() => lifecycle.activeChatIds('vk').filter(group),
        ...(dependencies.onboardingIntervalMs === undefined ? {} : {intervalMs:dependencies.onboardingIntervalMs})});
      function checkDisclosure(work:{scope:ConnectionScope;disclosureVersion?:number}) {
        if (!group(work.scope.chatId)) return undefined;
        const version = work.disclosureVersion ?? null;
        const current = onboarding.gate(work.scope);
        return {version,allowed:version !== null && current.version === version};
      }
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
      const publication = createPublicationService({ storage, port: channel.publicationPort,
        disclosureCurrent:work => work.jobId === undefined && group(work.scope.chatId)
          ? onboarding.gate(work.scope).version !== null : checkDisclosure(work)?.allowed ?? true });
      queue = createAgentLoopQueue({
        storage, logger, modelName: config.llm.model, tracing: config.tracing,
        client: dependencies.client ?? createLlmClient(config.llm),
        disclosure:checkDisclosure,
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
      const commandAuthorization = authorization;
      const router = createMessageRouter({ storage, queue, logger, authorization, onQueueFull: publication.queueFull,
        recognizeCommand:message => message.isGroupChat && message.isBot === false && parseTimezoneCommand(message.text) !== null
          ? {action:'chat.configure',minimumRole:'admin'} : null,
        identity:(scope,message)=>commandAuthorization.context({scope,userId:message.userId}),
        async executeCommand(context,message,isCurrent) {
          const input = parseTimezoneCommand(message.text);
          const timezone = input === null ? null : canonicalTimezone(input);
          if (timezone) await commandAuthorization.setTimezone(context,timezone,isCurrent);
        },
      });
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
    const results = await Promise.allSettled([queue?.stop(), poll,introductionWork, ...typing]);
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
