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
import { describeVkRights, vkIntroductionReplayWindowMs } from '../channels/vk/introduction.js';
import { isVkGroupChat } from '../channels/vk/normalize.js';
import type { ConnectionScope } from '../contracts/index.js';
import { setTimeout as delay } from 'node:timers/promises';
import { createAdminRecoveryService } from '../core/admin-recovery/service.js';
import { parseAdminRecoveryCommand } from '../core/admin-recovery/commands.js';
import { adminRecoveryStore } from '../storage/admin-recovery-store.js';
import { chatControlStore } from '../storage/chat-control-store.js';
import { createChatControlHandlers } from './chat-control.js';
import { createHistoryHandlers } from './history-retention.js';
import type { ChatLimits } from '../core/chat-limits/config.js';

interface ApplicationDependencies {
  readonly vk?: Parameters<typeof createVkChannel>[1];
  readonly client?: LlmClient;
  readonly readyTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  readonly onboardingIntervalMs?: number;
  readonly administrationIntervalMs?: number;
  readonly chatLimits?: Partial<ChatLimits>;
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
  let administrationWork: Promise<void> | undefined;
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
      storage = await openStorage(config.databasePath, { versioning: config.versioning, messageRetentionDays: config.tracing.messageRetentionDays });
      if (signal.aborted) return;
      const lifecycle = createLifecycleService({
        storage, ownerId: config.authorization.ownerId, source: unconfirmedLifecycleSource,
      });
      const controls=chatControlStore(storage);
      let ready = false;
      const channel = createVkChannel({
        ...config.vk, lifecycle, chats: storage.chats, signal, owner: config.authorization.ownerId,
        captureDisclosure: scope => {
          const disclosure=onboarding.capture(scope);
          try {
            const control=controls.capture(scope);
            return ()=>{
              const gate=disclosure(),state=control();
              return {...gate,journal:gate.journal&&state.journal,ordinary:state.ordinary};
            };
          } catch { return ()=>({journal:false,respond:false,version:null,ordinary:false});}
        },
        onReady() {
          if (signal.aborted || ready) return;
          ready = true;
          clearTimeout(readyTimer);
          logger.event({ event: 'application_ready' }, 'info');
          introductionWork = onboarding.run().catch(() => stop('vk_failed'));
          administrationWork = checkAdministration().catch(() => stop('vk_failed'));
        },
      }, dependencies.vk);
      const group = (chatId: ConnectionScope['chatId']) => {
        const local = vkLocalId(chatId);
        return local !== undefined && isVkGroupChat(local);
      };
      async function checkAdministration() {
        while (!signal.aborted) {
          for (const chatId of lifecycle.activeChatIds('vk').filter(group)) {
            if (signal.aborted) return;
            try {
              const scope=lifecycle.admissionScope(chatId);
              const guard={signal,isCurrent:()=>!signal.aborted&&lifecycle.isAdmissionCurrent(scope)};
              await lifecycle.refreshAdministration(scope,input=>channel.administrationEvidence.observe(scope,input,guard));
            } catch { /* Подключение и сведения будут проверены в следующем цикле. */ }
          }
          try { await delay(dependencies.administrationIntervalMs??30_000,undefined,{signal}); }
          catch { return; }
        }
      }
      const onboarding = createChatOnboarding({storage,lifecycle,port:channel.introduction!,signal,
        provider:'OpenCode Go',describeRights:describeVkRights,replayWindowMs:vkIntroductionReplayWindowMs,
        groups:() => lifecycle.activeChatIds('vk').filter(group),
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
        limits: dependencies.chatLimits ?? {},
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
      const ownerId=config.authorization.ownerId;
      const ownerPeer=vkLocalId(ownerId);
      adminRecoveryStore(storage).restoreSending(ownerId);
      const administration=createAdminRecoveryService({storage,authorization,lifecycle,ownerId,group,platform:channel.platform,signal,
        delivery:channel.administrationDelivery!,hasMember:channel.administrationEvidence.hasMember});
      const chatControl=createChatControlHandlers({storage,authorization,lifecycle,channel,ownerId,group,signal});
      const history=createHistoryHandlers({storage,authorization,lifecycle,channel,ownerId,group,signal,
        isRunning:queue.isRunning,wakeMaintenance:queue.wakeHistoryMaintenance??(()=>{})});
      const router = createMessageRouter({ storage, queue, logger, authorization, onQueueFull: publication.queueFull,
        recognizeCommand:(message,replyToOther) => history.recognize(message) ?? chatControl.recognize(message,replyToOther) ??
          (message.isGroupChat&&message.isBot===false&&parseTimezoneCommand(message.text)!==null
            ? {action:'chat.configure',minimumRole:'admin'} : null),
        identity:(scope,message)=>commandAuthorization.context({scope,userId:message.userId}),
        async executeCommand(context,message,isCurrent,replayOnly) {
          if (history.recognize(message)) return history.execute(context,message,isCurrent,replayOnly);
          const input = parseTimezoneCommand(message.text);
          if (input===null) return chatControl.execute(context,message,isCurrent);
          const timezone = canonicalTimezone(input);
          if (timezone) await commandAuthorization.setTimezone(context,timezone,isCurrent);
        },
      });
      readyTimer = setTimeout(() => stop('ready_timeout'), dependencies.readyTimeoutMs ?? 45_000);
      poll = channel.startRouted(router,undefined,{
        membership(scope,userId,present,messageId,at) { lifecycle.observeAdminMembership(scope,userId,present,messageId,at); },
        command(message,isCurrent) {
          const command=parseAdminRecoveryCommand(message.text);
          if (!command) return history.privateCommand(message,isCurrent) ?? chatControl.privateCommand(message,isCurrent);
          if (message.peerId!==ownerPeer || message.authorId!==ownerPeer || message.isMentioned || message.reply ||
            ownerPeer===undefined || ownerPeer<=0 || isVkGroupChat(ownerPeer)) return Promise.resolve();
          return administration.handle(ownerId,command,message.cmid,isCurrent);
        },
      }).then(
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
    const results = await Promise.allSettled([queue?.stop(), poll,introductionWork,administrationWork, ...typing]);
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
