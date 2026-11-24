import {
  addressedSlash,
  commandHelp,
  isCommandHelp,
  helpAction,
  unknownHint,
} from './command-help';
import { createQuestionnaireProgress } from '../core/questionnaire/progress';
import { createLlmAdmission } from '../core/llm-admission';
import { createPersonaCommands, isPersonaCommand } from './persona-commands';
import {
  createQuestionnaireCommands,
  openQuestionnaire,
  parseQuestionnaireCommand,
  parseQuestionnaireView,
} from './questionnaire-commands';
import { questionnaireAnswerHandler } from '../core/questionnaire/answer';
import { questionnaireProgressStore } from '../storage/questionnaire-progress-store';
import { questionnaireStore } from '../storage/questionnaire-store';
import { createProfileCommands } from './profile-commands';
import { createProfileUpdates } from '../core/profile-updates/service';
import { applicationSummaries } from './chat-summaries';
import { applicationTools } from './model-tools';
import { contextParticipantCards } from './context-participant-cards';
import { createGreetingService } from '../core/greetings/service';
import type { QuestionnaireInvitationSource } from '../core/greetings/invitation';
import { greetingStore } from '../storage/greeting-store';
import { addressPreferenceStore } from '../storage/address-preference-store';
import type { AddressPreferenceReference } from '../contracts/index';
import { createAddressPreferenceHandlers } from './address-preferences';
import { createPersonalCommands, groupPersonalCommand } from './personal-data';
import { personalDataStore } from '../storage/personal-data-store';
import { departedProfileBatch } from '../storage/participant-departures';
import { createVkChannel } from '../channels/index';
import type { ApplicationConfig } from '../config/application';
import {
  createAgentLoopQueue,
  createAuthorizationService,
  createContextPreparation,
  createLifecycleService,
  createMessageRouter,
  createPublicationService,
  createTokenBudgetAdministration,
  QueueError,
} from '../core/index';
import type { ChatQueue } from '../core/index';
import { createLlmClient, createLlmSessionId } from '../llm/index';
import type { LlmClient } from '../llm/index';
import type { SafeLogger } from '../logger/index';
import type { ApplicationFailure } from '../logger/types';
import { catalogAdministration, installStarterPersonas } from '../storage/catalog-admin';
import { openApplicationStorage } from './database-access';
import type { Storage } from '../storage/index';
import { createChatOnboarding } from '../core/chat-onboarding/service';
import { canonicalTimezone, parseTimezoneCommand } from '../core/chat-onboarding/timezone';
import { vkLocalId } from '../channels/vk/outbound';
import { describeVkRights, vkIntroductionReplayWindowMs } from '../channels/vk/introduction';
import { isVkGroupChat, vkChatId } from '../channels/vk/normalize';
import type { ChatId, ConnectionScope } from '../contracts/index';
import { setTimeout as delay } from 'node:timers/promises';
import { createAdminRecoveryService } from '../core/admin-recovery/service';
import { parseAdminRecoveryCommand } from '../core/admin-recovery/commands';
import { adminRecoveryStore } from '../storage/admin-recovery-store';
import { chatControlStore } from '../storage/chat-control-store';
import { createChatControlHandlers } from './chat-control';
import { createChatPassport } from './chat-passport';
import { chatPassportStore } from '../storage/chat-passport-store';
import { createHistoryHandlers } from './history-retention';
import type { ChatLimits } from '../core/chat-limits/config';
import { createTokenBudgetMembership } from '../core/chat-limits/token-budget-membership';
import { createUsageCommand, isUsageCommand } from './token-budget';
import { createPausedChatCommands } from './paused-chats';
import { participantRegistryStore } from '../storage/participant-registry';
import { createParticipantSync } from './participant-sync';
import { createReminderHandlers } from './reminders';
import { parseReminderCommand } from '../core/reminders/commands';

interface ApplicationDependencies {
  readonly vk?: Parameters<typeof createVkChannel>[1];
  readonly client?: LlmClient;
  readonly auxiliaryClient?: LlmClient;
  readonly readyTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  readonly onboardingIntervalMs?: number;
  readonly administrationIntervalMs?: number;
  readonly reminderIntervalMs?: number;
  readonly greetingIntervalMs?: number;
  readonly questionnaireInvitations?: QuestionnaireInvitationSource;
  readonly greetingRules?: (scope: ConnectionScope) => string | undefined;
  readonly membershipScanMs?: number;
  readonly membershipStaggerMs?: number;
  readonly chatLimits?: Partial<ChatLimits>;
}

export async function runApplication(
  config: ApplicationConfig,
  logger: SafeLogger,
  externalSignal: AbortSignal,
  dependencies: ApplicationDependencies = {},
): Promise<ApplicationFailure | null> {
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
  let membershipWork: Promise<void> | undefined;
  let greetingWork: Promise<void> | undefined;
  let reminderWork: Promise<void> | undefined;
  let summaryWork: Promise<void> | undefined;
  let profileUpdateWork: Promise<void> | undefined;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  const typing = new Set<Promise<void>>();
  const floodPublications = new Set<Promise<void>>();
  const questionnairePublications = new Set<Promise<void>>();

  function stop(failure: ApplicationFailure | null) {
    if (signal.aborted) return;
    reason = failure;
    stopTimer = setTimeout(
      () => deadline.resolve('stop_timeout'),
      dependencies.stopTimeoutMs ?? 15_000,
    );
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
      storage = await openApplicationStorage(config.databasePath, {
        versioning: config.versioning,
        messageRetentionDays: config.tracing.messageRetentionDays,
      });
      if (signal.aborted) return;
      installStarterPersonas(storage, Date.now());
      let canWritePrivate: (chatId: ChatId) => Promise<boolean> = async () => false;
      const lifecycle = createLifecycleService({
        storage,
        ownerId: config.authorization.ownerId,
        source: {
          async observe({ chatId }) {
            return (await canWritePrivate(chatId))
              ? { confidence: 'confirmed', bot: 'present' }
              : { confidence: 'unavailable', bot: 'unknown' };
          },
        },
      });
      const privacy = personalDataStore(storage);
      const questionnaireProgress = createQuestionnaireProgress(storage);
      const questionnaireTemplates = questionnaireStore(storage);
      const registry = participantRegistryStore(storage);
      privacy.purgeExpired(Date.now());
      privacy.cleanup(Date.now());
      registry.purgeDeparted(Date.now());
      const controls = chatControlStore(storage);
      let ready = false;
      const adminStore = adminRecoveryStore(storage);
      const channel: ReturnType<typeof createVkChannel> = createVkChannel(
        {
          ...config.vk,
          lifecycle,
          chats: storage.chats,
          signal,
          owner: config.authorization.ownerId,
          captureDisclosure: (scope) => {
            const disclosure = onboarding.capture(scope);
            try {
              const control = controls.capture(scope);
              return () => {
                const gate = disclosure(),
                  state = control();
                return {
                  ...gate,
                  journal: gate.journal && state.journal,
                  ordinary: state.ordinary,
                };
              };
            } catch {
              return () => ({ journal: false, respond: false, version: null, ordinary: false });
            }
          },
          capturePrivateDisclosure: (scope) =>
            onboarding.configuredForProfiles() ? onboarding.capture(scope) : undefined,
          notifyPrivate: async (scope, current, message) => {
            if (!onboarding.configuredForProfiles()) return true;
            if (onboarding.privatePending(scope)) {
              const command = (message.literalText ?? message.text).trim();
              const questionnaire =
                !message.hasForwarded &&
                !message.attachments.length &&
                (parseQuestionnaireCommand(command) || parseQuestionnaireView(command));
              await onboarding.notifyPrivate(scope, current);
              if (questionnaire) {
                const isCurrent = () => current() && !onboarding.privatePending(scope);
                if (isCurrent())
                  await channel.replyPrivateControl(
                    vkChatId(message.authorId),
                    `Чтобы продолжить, повторите ${command}.`,
                    { signal, isCurrent, allow: async () => isCurrent() },
                  );
                return false;
              }
            }
            return !onboarding.privatePending(scope) && current();
          },
          async onMembershipChanged(scope, event, identity) {
            const user = event.subjectId && vkLocalId(event.subjectId);
            if (
              registry.observe(
                scope,
                event,
                identity,
                group(scope.chatId) && typeof user === 'number' && user > 0,
              )
            ) {
              membership.request(scope);
              wakeGreeting();
            }
          },
          verifyFirstPrivate(message) {
            return (
              message.peerId > 0 &&
              !isVkGroupChat(message.peerId) &&
              message.authorId === message.peerId &&
              !message.hasReply &&
              !message.hasForwarded &&
              (onboarding.configuredForProfiles() ||
                !!parseReminderCommand(message.text, false) ||
                (!message.attachments.length && isPersonaCommand(message.text)))
            );
          },
          onReady() {
            if (signal.aborted || ready) return;
            ready = true;
            clearTimeout(readyTimer);
            logger.event({ event: 'application_ready' }, 'info');
            introductionWork = onboarding.run().catch(() => stop('vk_failed'));
            membershipWork = membership.run().catch(() => stop('storage_failed'));
            administrationWork = checkAdministration().catch(() => stop('vk_failed'));
            greetingWork = deliverGreetings().catch(() => stop('storage_failed'));
            reminderWork = deliverReminders().catch(() => stop('storage_failed'));
            summaryWork = summaries.run().catch(() => stop('storage_failed'));
            profileUpdateWork = profileUpdates.run().catch(() => stop('storage_failed'));
          },
        },
        dependencies.vk,
      );
      canWritePrivate = (chatId) => channel.reminderDelivery(chatId).canWrite({ signal });
      const reminders = createReminderHandlers({ storage, channel, lifecycle, signal });
      async function deliverReminders() {
        while (!signal.aborted) {
          if (await reminders.due()) continue;
          try {
            await delay(dependencies.reminderIntervalMs ?? 1_000, undefined, { signal });
          } catch {
            return;
          }
        }
      }
      const group = (chatId: ConnectionScope['chatId']) => {
        const local = vkLocalId(chatId);
        return local !== undefined && isVkGroupChat(local);
      };
      const membership = createParticipantSync({
        signal,
        activeGroups: () => lifecycle.activeChatIds('vk').filter(group),
        scopeFor: lifecycle.admissionScope,
        confirmed: wakeGreeting,
        isCurrent: lifecycle.isAdmissionCurrent,
        refresh: createTokenBudgetMembership(storage, channel.humanMembership),
        scanMs: dependencies.membershipScanMs ?? dependencies.administrationIntervalMs ?? 1_000,
        staggerMs: dependencies.membershipStaggerMs ?? 5 * 60_000,
      });
      async function checkAdministration() {
        while (!signal.aborted) {
          profiles.prune(Date.now());
          passports.prune(Date.now());
          const moreProfiles = privacy.purgeExpired(Date.now()) === 100;
          const moreMessages = privacy.cleanup(Date.now()) === 100;
          const moreDepartures = registry.purgeDeparted(Date.now()) === departedProfileBatch;
          if (moreProfiles || moreMessages || moreDepartures) {
            await delay(0);
            continue;
          }
          for (const chatId of lifecycle.activeChatIds('vk').filter(group)) {
            if (signal.aborted) return;
            try {
              const scope = lifecycle.admissionScope(chatId);
              const role = adminStore.communityRole(chatId);
              const guard = {
                signal,
                isCurrent: () => !signal.aborted && lifecycle.isAdmissionCurrent(scope),
              };
              await lifecycle.refreshAdministration(scope, (input) =>
                channel.administrationEvidence.observe(scope, input, guard),
              );
              if (role !== true && adminStore.communityRole(chatId) === true) {
                const active = lifecycle.admissionScope(chatId);
                if (registry.lastAttemptIncomplete(active)) membership.request(active);
              }
            } catch {
              /* Подключение и сведения будут проверены в следующем цикле. */
            }
          }
          try {
            await delay(dependencies.administrationIntervalMs ?? 30_000, undefined, { signal });
          } catch {
            return;
          }
        }
      }
      const onboarding = createChatOnboarding({
        storage,
        lifecycle,
        port: channel.introduction!,
        signal,
        provider: 'OpenCode Go',
        describeRights: describeVkRights,
        replayWindowMs: vkIntroductionReplayWindowMs,
        groups: () => lifecycle.activeChatIds('vk').filter(group),
        ...(dependencies.onboardingIntervalMs === undefined
          ? {}
          : { intervalMs: dependencies.onboardingIntervalMs }),
      });
      function checkDisclosure(work: { scope: ConnectionScope; disclosureVersion?: number }) {
        if (
          !group(work.scope.chatId) &&
          !onboarding.configuredForProfiles() &&
          work.disclosureVersion === undefined
        )
          return undefined;
        const version = work.disclosureVersion ?? null;
        const current = onboarding.gate(work.scope);
        return { version, allowed: version !== null && current.version === version };
      }
      const addressPreferences = addressPreferenceStore(storage);
      const greetings = createGreetingService({
        store: greetingStore(storage),
        profiles: storage.profileFacts,
        address: addressPreferences,
        scope: (window) => {
          const scope = lifecycle.admissionScope(window.chatId);
          if (scope.generation !== window.generation)
            throw Error('Приветствие относится к прежнему подключению.');
          return scope;
        },
        scopeCurrent: lifecycle.isAdmissionCurrent,
        signal,
        limit: config.responseRate.responsesPerMinute,
        ...(dependencies.greetingRules ? { rules: dependencies.greetingRules } : {}),
        questionnaire: questionnaireProgress.invitations(
          dependencies.questionnaireInvitations ?? {
            action: (scope) => (questionnaireTemplates.current(scope) ? openQuestionnaire : null),
            state(scope, user) {
              const state = controls.read(scope);
              return state.enabled &&
                state.mode !== 'silent' &&
                privacy.profileAllowed(scope, user, Date.now())
                ? 'available'
                : 'unavailable';
            },
          },
        ),
        port: {
          writing: (scope, guard) => channel.introduction!.writing(scope, 'chat', guard),
          name: channel.getUserName,
          send: channel.sendGreeting,
          sendInvitation: channel.sendQuestionnaireInvitation,
        },
      });
      let greetingWait: AbortController | undefined;
      function wakeGreeting() {
        greetingWait?.abort();
      }
      async function deliverGreetings() {
        greetings.recover();
        while (!signal.aborted) {
          if (await greetings.due()) continue;
          greetingWait = new AbortController();
          try {
            await delay(dependencies.greetingIntervalMs ?? 1000, undefined, {
              signal: AbortSignal.any([signal, greetingWait.signal]),
            });
          } catch (error) {
            if (!signal.aborted && !greetingWait.signal.aborted) throw error;
          } finally {
            greetingWait = undefined;
          }
        }
      }

      const addressCurrent = (scope: ConnectionScope, reference: AddressPreferenceReference) => {
        try {
          return addressPreferences.current(scope, reference);
        } catch {
          return false;
        }
      };
      const passport = chatPassportStore(storage);
      const llmAdmission = createLlmAdmission(
        config.llmAdmission,
        undefined,
        () => queue?.llmRecovery,
        (outcome) => logger.event({ event: 'llm_admission', outcome }, 'info'),
      );
      const auxiliaryClient =
        dependencies.auxiliaryClient ??
        createLlmClient({ ...config.llm, model: config.auxiliaryModel });
      const summaries = applicationSummaries({
        storage,
        llmAdmission,
        client: auxiliaryClient,
        model: config.auxiliaryModel,
        sessionSecret: config.sessionSecret,
        ...config.summaries,
        modelContext: config.context.modelContextTokens,
        signal,
        port: channel.publicationPort,
        platform: channel.platform,
        group,
        inputBudget: config.context.inputBudgetTokens,
        disclosure: (scope) =>
          !group(scope.chatId) && !onboarding.configuredForProfiles()
            ? 0
            : onboarding.gate(scope).version,
        backgroundReady: () =>
          !!queue?.isRunning() &&
          !queue.signal.aborted &&
          queue.stats().depthQueued === 0 &&
          queue.stats().depthRunning === 0,
      });
      const preparation = createContextPreparation({
        summaries: summaries.context,
        storage,
        config: config.context,
        logger,
        sessionId: createLlmSessionId(config.sessionSecret),
        capabilities: ({ chatId }) => channel.capabilities({ chatId }),
        addressForm: addressPreferences.resolve,
        participantCards: contextParticipantCards(storage),
        passport: { read: passport.read, current: passport.current },
      });
      const contextFailure = preparation.checkStartup(
        await catalogAdministration(storage).systemPrompt(),
      );
      if (contextFailure) {
        stop(contextFailure);
        return;
      }
      if (signal.aborted) return;
      authorization = await createAuthorizationService({
        config: config.authorization,
        store: storage.authorization,
      });
      if (signal.aborted) return;

      startupFailure = 'queue_failed';
      const publication = createPublicationService({
        storage,
        port: channel.publicationPort,
        addressCurrent,
        responseBudget: () => queue?.responseBudget,
        disclosureCurrent: (work) =>
          work.jobId === undefined && group(work.scope.chatId)
            ? onboarding.gate(work.scope).version !== null
            : (checkDisclosure(work)?.allowed ?? true),
      });
      const modelClient = dependencies.client ?? createLlmClient(config.llm);
      const profileUpdates = createProfileUpdates({
        storage,
        llmAdmission,
        logger,
        client: modelClient,
        sessionId: createLlmSessionId('profile-update:' + config.sessionSecret),
        scope: lifecycle.admissionScope,
        group,
        signal,
        modelContextTokens: config.context.modelContextTokens,
        maxOutputTokens: preparation.config.maxOutputTokens,
      });
      const questionnaireAttempts = questionnaireProgressStore(storage);
      queue = createAgentLoopQueue({
        llmAdmission,
        llmRecovery: config.llmRecovery,
        recapAnswer: summaries.answer,
        questionnaireAnswer: questionnaireAnswerHandler({
          llmAdmission,
          store: questionnaireAttempts,
          client: modelClient,
          sessionId: createLlmSessionId(config.sessionSecret),
          maxOutputTokens: preparation.config.maxOutputTokens,
          inputLimit: config.context.modelContextTokens - preparation.config.maxOutputTokens,
          modelName: config.llm.model,
          disclosed: (work) => checkDisclosure(work)?.allowed ?? true,
        }),
        storage,
        logger,
        modelName: config.llm.model,
        tools: applicationTools(storage, channel, authorization, auxiliaryClient),
        modelInputLimit: config.context.modelContextTokens - preparation.config.maxOutputTokens,
        tracing: config.tracing,
        limits: dependencies.chatLimits ?? {},
        tokenBudget: true,
        autonomousReplies: true,
        responseRate: config.responseRate,
        client: modelClient,
        disclosure: checkDisclosure,
        addressCurrent,
        platform: channel.platform,
        signal,
        preparationTimeoutMs: preparation.config.preparationTimeoutMs,
        postPreparationMarginMs: preparation.config.postPreparationMarginMs,
        prepare(work) {
          if (work.route?.kind === 'initiative') return preparation.prepare(work);
          const operation = channel
            .sendTypingForWork(work.scope, work)
            .finally(() => typing.delete(operation));
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
      const ownerId = config.authorization.ownerId;
      const ownerPeer = vkLocalId(ownerId);
      adminRecoveryStore(storage).restoreSending(ownerId);
      const administration = createAdminRecoveryService({
        storage,
        authorization,
        lifecycle,
        ownerId,
        group,
        platform: channel.platform,
        signal,
        delivery: channel.administrationDelivery!,
        hasMember: channel.administrationEvidence.hasMember,
      });
      const chatControl = createChatControlHandlers({
        storage,
        authorization,
        lifecycle,
        channel,
        ownerId,
        group,
        signal,
      });
      const history = createHistoryHandlers({
        storage,
        authorization,
        lifecycle,
        channel,
        ownerId,
        group,
        signal,
        isRunning: queue.isRunning,
        wakeMaintenance: queue.wakeHistoryMaintenance ?? (() => {}),
      });
      const usage = createUsageCommand({
        channel,
        ownerId,
        signal,
        budget: createTokenBudgetAdministration({ storage, authorization, isGroupChat: group }),
      });
      const personal = createPersonalCommands({
        privacy,
        channel,
        lifecycle,
        onboarding,
        signal,
        ownerId,
        authorization,
        storage,
      });
      const profiles = createProfileCommands({
        storage,
        authorization,
        privacy,
        channel,
        lifecycle,
        onboarding,
        signal,
      });
      const passports = createChatPassport({ storage, authorization, channel, lifecycle, signal });
      const questionnaires = createQuestionnaireCommands({
        storage,
        authorization,
        lifecycle,
        channel,
        signal,
        progress: questionnaireProgress,
        present: publication.presentQuestionnaire,
        track(work) {
          const publication = work
            .catch((error: unknown) => logger.componentError(error))
            .finally(() => questionnairePublications.delete(publication));
          questionnairePublications.add(publication);
        },
      });
      const address = createAddressPreferenceHandlers({ storage, channel, signal });
      const personas = createPersonaCommands({ storage, authorization, channel, signal });
      const pausedChats = createPausedChatCommands({ channel, lifecycle, ownerId, signal });
      const router = createMessageRouter({
        storage,
        queue,
        logger,
        authorization,
        canAnswerQuestionnaire: questionnaireAttempts.canAnswer,
        onQueueFull: publication.queueFull,
        onDecision: profileUpdates.wake,
        onFlood(scope, candidate, isCurrent) {
          const operation = publication
            .flood(scope, candidate, { signal, isCurrent })
            .finally(() => floodPublications.delete(operation));
          floodPublications.add(operation);
        },
        recognizeCommand: (message, replyToOther, scope) =>
          questionnaires.recognize(scope, message) ??
          passports.recognize(scope, message) ??
          chatControl.editor.recognizeReply(scope, message) ??
          (isUsageCommand(message.text)
            ? ({ action: 'usage.read', minimumRole: 'owner' } as const)
            : null) ??
          profiles.recognize(message) ??
          groupPersonalCommand(message) ??
          personas.recognize(message) ??
          history.recognize(message) ??
          chatControl.recognize(message, replyToOther) ??
          reminders.recognize(message) ??
          address.recognize(message) ??
          (message.isGroupChat &&
          message.isBot === false &&
          parseTimezoneCommand(message.text) !== null
            ? { action: 'chat.configure', minimumRole: 'admin' }
            : null) ??
          (addressedSlash(message) ? helpAction : null),
        identity: (scope, message) =>
          commandAuthorization.context({ scope, userId: message.userId }),
        async executeCommand(context, message, isCurrent, replayOnly, command) {
          if (command?.action === 'commands.read') {
            const role = await commandAuthorization.role(context);
            if (!role.allowed || !isCurrent()) return;
            const state = controls.read(context.scope);
            const current = () => {
              if (!isCurrent()) return false;
              const latest = controls.read(context.scope);
              return latest.enabled === state.enabled && latest.mode === state.mode;
            };
            const guard = {
              signal,
              isCurrent: current,
              allow: async () => {
                if (!current()) return false;
                const fresh = await commandAuthorization.role(context);
                return (
                  fresh.allowed &&
                  fresh.value === role.value &&
                  (await commandAuthorization.check(context, 'commands.read')).allowed &&
                  current()
                );
              },
            };
            const text = isCommandHelp(message.text)
              ? commandHelp(
                  role.value,
                  message.isGroupChat,
                  state.enabled,
                  state.mode,
                  message.userId,
                )
              : unknownHint(message.text);
            return message.isGroupChat
              ? channel.replyGroupControl(context.scope, text, guard)
              : channel.replyPrivateControl(message.userId, text, guard);
          }
          if (questionnaires.recognize(context.scope, message))
            return questionnaires.execute(context, message, isCurrent);
          if (passports.recognize(context.scope, message))
            return passports.execute(context, message, isCurrent);
          if (chatControl.editor.recognizeReply(context.scope, message))
            return chatControl.editor.reply(context, message, isCurrent);
          if (profiles.recognize(message)) return profiles.group(context.scope, message, isCurrent);
          if (personas.recognize(message)) return personas.execute(context, message, isCurrent);
          if (groupPersonalCommand(message)) {
            const peerId = vkLocalId(context.scope.chatId),
              authorId = vkLocalId(context.userId);
            if (peerId !== undefined && authorId !== undefined)
              await personal(
                {
                  peerId,
                  authorId,
                  text: message.text,
                  cmid: Number(message.messageId),
                  reply: undefined,
                },
                () => isCurrent() && lifecycle.isAdmissionCurrent(context.scope),
              );
            return;
          }
          if (history.recognize(message))
            return history.execute(context, message, isCurrent, replayOnly);
          if (reminders.recognize(message))
            return reminders.execute(context.scope, message, isCurrent, replayOnly);
          if (address.recognize(message)) return address.execute(context.scope, message, isCurrent);
          const input = parseTimezoneCommand(message.text);
          if (input === null) return chatControl.execute(context, message, isCurrent);
          const timezone = canonicalTimezone(input);
          const decision = timezone
            ? await commandAuthorization.setTimezone(context, timezone, isCurrent)
            : await commandAuthorization.check(context, 'chat.configure');
          if (!decision.allowed || !isCurrent()) return;
          const text = timezone
            ? `Часовой пояс сохранён: ${timezone}.`
            : 'Укажите часовой пояс, например /часовой-пояс Europe/Moscow.';
          await channel.replyGroupControl(context.scope, text, {
            signal,
            isCurrent,
            allow: async () =>
              isCurrent() && (await commandAuthorization.check(context, 'chat.configure')).allowed,
          });
        },
      });
      readyTimer = setTimeout(() => stop('ready_timeout'), dependencies.readyTimeoutMs ?? 45_000);
      poll = channel
        .startRouted(router, undefined, {
          membership(scope, userId, present, messageId, at) {
            lifecycle.observeAdminMembership(scope, userId, present, messageId, at);
          },
          command(message, isCurrent) {
            if (
              isCommandHelp(message.text) &&
              message.peerId === ownerPeer &&
              message.authorId === ownerPeer &&
              ownerPeer !== undefined &&
              ownerPeer > 0 &&
              !isVkGroupChat(ownerPeer) &&
              !message.isMentioned &&
              !message.hasReply &&
              !message.hasForwarded &&
              !message.attachments.length
            ) {
              const active = lifecycle.activeChatIds('vk').includes(ownerId);
              if (!active || !controls.read(lifecycle.admissionScope(ownerId)).enabled)
                return channel.replyPrivateControl(
                  ownerId,
                  commandHelp('owner', false, false, 'silent', ownerId),
                  { signal, isCurrent, allow: async () => isCurrent() },
                );
            }
            if (
              passports.beforePersonalCommands(message) ||
              chatControl.editor.beforePersonalCommands(message)
            )
              return undefined;
            const passportAction = passports.privateCommand(message);
            if (passportAction) return passportAction;
            const profileAction = profiles.private(message, isCurrent);
            if (profileAction) return profileAction;
            const personalAction = !isVkGroupChat(message.peerId) && personal(message, isCurrent);
            if (personalAction) return personalAction;
            const command = parseAdminRecoveryCommand(message.text);
            if (!command)
              return (
                pausedChats(message, isCurrent) ??
                usage(message, isCurrent) ??
                history.privateCommand(message, isCurrent) ??
                chatControl.privateCommand(message, isCurrent)
              );
            if (
              message.peerId !== ownerPeer ||
              message.authorId !== ownerPeer ||
              message.isMentioned ||
              message.reply ||
              ownerPeer === undefined ||
              ownerPeer <= 0 ||
              isVkGroupChat(ownerPeer)
            )
              return Promise.resolve();
            return administration.handle(ownerId, command, message.cmid, isCurrent);
          },
        })
        .then(
          () => {
            if (!signal.aborted) stop('vk_failed');
          },
          () => stop('vk_failed'),
        );
    } catch (error) {
      stop(error instanceof QueueError && error.code === 'owned' ? 'queue_owned' : startupFailure);
    }
  })();

  const cleanup = (async () => {
    await stopping.promise;
    await startup;
    const results = await Promise.allSettled([
      queue?.stop(),
      poll,
      introductionWork,
      administrationWork,
      membershipWork,
      reminderWork,
      greetingWork,
      profileUpdateWork,
      summaryWork,
      ...typing,
      ...floodPublications,
      ...questionnairePublications,
    ]);
    authorization?.dispose();
    try {
      await storage?.close();
    } catch {
      return reason ?? 'stop_failed';
    }
    return (
      reason ?? (results.some((result) => result.status === 'rejected') ? 'stop_failed' : null)
    );
  })();

  try {
    return await Promise.race([cleanup, deadline.promise]);
  } finally {
    clearTimeout(stopTimer);
    externalSignal.removeEventListener('abort', stopFromSignal);
  }
}
