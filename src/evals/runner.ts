import { evaluateChatSummary, summaryFactChecks } from './chat-summaries';
import { setTimeout as delay } from 'node:timers/promises';
import { chatSummaryCase } from './scenarios';
import { deniedGrantClient, seedPassport } from './passport';
import { seedPersonaProfile } from './personas';
import { chatPassportStore } from '../storage/chat-passport-store';
import { applicationTools } from '../app/model-tools';
import { contextParticipantCards } from '../app/context-participant-cards';
import { createContextAuthority } from '../core/authorization/context';
import type { ConnectionScope } from '../contracts/index';
import { historyEvaluationAdapter, historySearchClient, yesterdayClient } from './history';
import {
  createAgentLoopQueue,
  createContextPreparation,
  createLifecycleService,
  createMessageRouter,
  createPublicationService,
} from '../core/index';
import type { ChatQueue, PublicationRequest, QueueCompletion } from '../core/index';
import type { LlmClient, LlmRequest, LlmResult } from '../llm/types';
import { addressPreferenceStore } from '../storage/address-preference-store';
import { disclosureStore } from '../storage/chat-disclosure-store';
import { activeGroupReplyDisclosure } from '../core/chat-onboarding/introduction-text';
import { chatLimits } from '../core/chat-limits/config';
import { responseRateConfig } from '../core/chat-limits/response-rate-config';
import { createLlmAdmission } from '../core/llm-admission';
import {
  createGroupReplyGate,
  groupReplyDecision,
  groupReplyInstructionVersion,
  groupReplyModel,
} from '../core/message-router/group-reply-gate';
import { groupReplyGateStore } from '../storage/group-reply-gate-store';
import { catalogAdministration, installStarterPersonas } from '../storage/catalog-admin';
import { openStorage, type Storage } from '../storage/index';
import type { TraceRecord } from '../storage/trace-types';
import type { EvaluationResult, GroupReplyObservation, Observation, Scenario } from './types';

const model = 'synthetic-local';
const loopTimeoutMs = 1_000;
const handlerMarginMs = 3_000;

function classifyFailure(
  completion: QueueCompletion,
  trace: TraceRecord,
): EvaluationResult['reason'] {
  if (completion.preparationFailure) return completion.preparationFailure;
  const result = completion.result;
  if (!result) return 'processing_failed';
  if (result.kind === 'error') return result.code;
  if (
    result.kind === 'attempt_limit' ||
    result.kind === 'rate_limit' ||
    result.kind === 'deadline_exceeded' ||
    result.kind === 'cancelled'
  )
    return result.kind;
  const { status, reason } = trace.payload.publication;
  if (status !== 'delivered' && (status !== 'suppressed' || reason === 'trace_write_failed'))
    return 'publication_failed';
  return null;
}

function classify(
  scenario: Scenario,
  trace: TraceRecord | null,
  reason: EvaluationResult['reason'],
  observation: Observation,
): EvaluationResult {
  const criteria = scenario.criteria.map(({ id, check }) => {
    if (reason) return { id, outcome: 'not_checked', reason: 'technical_error' } as const;
    return check(observation)
      ? ({ id, outcome: 'passed', reason: 'matched' } as const)
      : ({ id, outcome: 'failed', reason: 'mismatch' } as const);
  });
  return {
    scenarioId: scenario.id,
    scenarioRevision: scenario.revision,
    model: trace?.payload.model.name ?? null,
    prompt: trace?.payload.prompt ?? null,
    ...(scenario.persona ? { persona: observation.personaVersion ?? null } : {}),
    ...(observation.groupReply ? { groupReply: observation.groupReply } : {}),
    outcome: reason
      ? 'technical_error'
      : criteria.every((criterion) => criterion.outcome === 'passed')
        ? 'passed'
        : 'failed',
    reason,
    criteria,
  };
}

async function waitForSettlement(
  settled: Promise<QueueCompletion>,
  timeoutMs: number,
): Promise<QueueCompletion | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(resolve, timeoutMs + handlerMarginMs + 500, null);
    });
    return await Promise.race([settled, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function enableSyntheticProfiles(storage: Storage, scope: ConnectionScope, group = false): boolean {
  const disclosure = disclosureStore(storage);
  const notice = 'Обращение можно выбрать и скрыть.';
  const version = disclosure.register(
    {
      profileNotice: notice,
      provider: 'Оценочный стенд',
      dataPolicy: 'Синтетическая переписка',
      storagePolicy: 'Только временная база',
      detailsText: 'Сведения для синтетического сценария.',
      detailsUrl: 'https://example.test/privacy',
      ownerContact: 'Синтетический владелец',
      change: 'material',
    },
    1,
  );
  const publication = disclosure.ensure(scope, 'introduction', version);
  const claim = disclosure.claim(
    scope,
    publication.id,
    group ? activeGroupReplyDisclosure : notice,
    10,
  );
  return !!claim && disclosure.finish(scope, claim, 'delivered', 11, null, 'intro');
}

function sampleModel(model: string) {
  const sample = {
    model,
    attempts: 0,
    latencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    unknownInput: 0,
    unknownOutput: 0,
  };
  return {
    sample,
    async measure(invoke: () => Promise<LlmResult>) {
      sample.attempts++;
      const startedAt = performance.now();
      const result = await invoke();
      sample.latencyMs += Math.round(performance.now() - startedAt);
      const usage = 'usage' in result ? result.usage : undefined;
      if (usage?.input == null) sample.unknownInput++;
      else sample.inputTokens += usage.input;
      if (usage?.output == null) sample.unknownOutput++;
      else sample.outputTokens += usage.output;
      return result;
    },
  };
}

export async function runScenario(
  scenario: Scenario,
  client: LlmClient = defaultClient(scenario),
  settings: {
    readonly modelName?: string;
    readonly timeoutMs?: number;
    readonly groupReplyClient?: LlmClient;
  } = {},
): Promise<EvaluationResult> {
  const timeoutMs = settings.timeoutMs ?? loopTimeoutMs;
  let firstRequest: LlmRequest | undefined;
  let request: LlmRequest | null = null;
  let answer: PublicationRequest | null = null;
  let trace: TraceRecord | null = null;
  const gateSettings = scenario.groupReply;
  const gateMeter = sampleModel(groupReplyModel);
  const mainMeter = sampleModel(settings.modelName ?? model);
  let gateChoice: GroupReplyObservation['decision'] = 'none';
  let gateFailure: EvaluationResult['reason'] = null;
  let mainStartMs: number | null = null;
  let admittedAt = 0;
  let grantsUnchanged: boolean | undefined;
  let stage: EvaluationResult['reason'] = 'setup_failed';
  const evaluate = (reason: EvaluationResult['reason']) => {
    const personaVersion = trace?.payload.context?.persona?.version;
    return classify(scenario, trace, reason, {
      ...(firstRequest ? { firstRequest } : {}),
      request,
      answer: trace?.payload.publication.status === 'delivered' ? answer : null,
      historyTruncated: trace?.payload.context?.historyTruncated ?? false,
      publicationReason: trace?.payload.publication.reason ?? 'none',
      route: trace?.payload.route ?? null,
      ...(gateSettings
        ? {
            groupReply: {
              expected: gateSettings.expected,
              decision: gateChoice,
              instruction: groupReplyInstructionVersion,
              ...(gateSettings.comparison ? { comparison: gateSettings.comparison } : {}),
              mainStartMs,
              gate: { ...gateMeter.sample },
              main: { ...mainMeter.sample },
              delivered: trace?.payload.publication.status === 'delivered',
            },
          }
        : {}),
      ...(grantsUnchanged === undefined ? {} : { grantsUnchanged }),
      ...(personaVersion ? { personaVersion } : {}),
      ...(trace?.payload.summary ? { modelAttempts: trace.payload.summary.attempts } : {}),
    });
  };

  try {
    const storage = await openStorage(':memory:');
    try {
      if (scenario.historySearch === 'failed') {
        const reader = storage.contextMessages;
        // Остальные порты зарегистрированы на исходном объекте Storage.
        Object.assign(storage, {
          contextMessages: {
            ...reader,
            history() {
              throw Error('Синтетический сбой чтения журнала.');
            },
          } satisfies typeof reader,
        });
      }
      const lifecycle = createLifecycleService({
        storage,
        ownerId: 'synthetic:owner',
        source: {
          async observe() {
            return { confidence: 'confirmed', bot: 'present' };
          },
        },
      });
      const syntheticAt = Date.now();
      const stimulus = gateSettings
        ? { ...scenario.input, timestamp: syntheticAt }
        : scenario.input;
      const startChat = async (chatId: Scenario['input']['chatId']) => {
        const { scope } = await lifecycle.verify(chatId);
        if (!scope) throw Error('Отсутствует область синтетической беседы.');
        await storage.chats.create(scope, {
          enabled: true,
          responseMode: gateSettings?.mode ?? 'normal',
          timezone: scenario.historyTimezone ?? 'UTC',
          createdAt: 0,
        });
        return scope;
      };
      const scope = await startChat(scenario.input.chatId);
      if (gateSettings && !enableSyntheticProfiles(storage, scope, true))
        return evaluate('setup_failed');
      for (const message of scenario.history) {
        const target = message.chatId === scope.chatId ? scope : await startChat(message.chatId);
        await storage.messages.append(
          target,
          message.chatId === scope.chatId
            ? {
                ...message,
                isGroupChat: scenario.input.isGroupChat,
                ...(gateSettings
                  ? { timestamp: syntheticAt - 1000, senderBot: message.senderBot ?? false }
                  : {}),
              }
            : message,
        );
      }
      const persona = scenario.persona;
      if (persona) {
        installStarterPersonas(storage, 0);
        if (!persona.useDefault) {
          const selected = await storage.authorization.transaction(scope, (tx) =>
            tx.selectStarterPersona(stimulus.userId, persona.id, {
              sourceChatId: scope.chatId,
              messageId: 90,
              timestamp: stimulus.timestamp,
            }),
          );
          if (selected.status !== 'selected') return evaluate('setup_failed');
        }
        if (
          persona.profile &&
          (!enableSyntheticProfiles(storage, scope) ||
            !(await seedPersonaProfile(storage, scope, persona.profile)))
        )
          return evaluate('setup_failed');
      }
      const passport = scenario.passport && chatPassportStore(storage);
      if (passport && scenario.passport) {
        if (!seedPassport(passport, scope, scenario.passport.local))
          return evaluate('setup_failed');
        if (
          scenario.passport.neighbor &&
          !seedPassport(
            passport,
            await startChat('synthetic:passport-neighbor'),
            scenario.passport.neighbor,
          )
        )
          return evaluate('setup_failed');
      }
      const beforeGrant =
        scenario.passport?.tryGrant || persona?.profile
          ? await storage.authorization.transaction(scope, (tx) => tx.bases(stimulus.userId))
          : undefined;
      const addressPreferences = scenario.address && addressPreferenceStore(storage);
      const preference = scenario.address?.preference;
      if (addressPreferences && preference) {
        const target =
          preference.state === 'neighbor' ? await startChat('synthetic:address-neighbor') : scope;
        if (!enableSyntheticProfiles(storage, target)) return evaluate('setup_failed');
        const update = (
          sequence: number,
          change: Parameters<typeof addressPreferences.change>[3],
        ) =>
          addressPreferences.change(
            target,
            preference.owner,
            { sequence, at: 20 + sequence, isGroupChat: scenario.input.isGroupChat },
            change,
            () => true,
          ) === 'changed';
        if (!update(1, { kind: 'set', form: preference.form })) return evaluate('setup_failed');
        if (preference.state === 'reset' && !update(2, { kind: 'reset' }))
          return evaluate('setup_failed');
        if (preference.state === 'hidden' && !update(2, { kind: 'visibility', value: 'bot' }))
          return evaluate('setup_failed');
      }
      const catalog = catalogAdministration(storage);
      const created = await catalog.append({
        key: scenario.promptKey ?? 'eval',
        kind: 'system_prompt',
        text: scenario.prompt,
        createdAt: 0,
        expectedHead: null,
      });
      if (created.status !== 'created' || created.value.ref.area !== 'global')
        return evaluate('setup_failed');
      if ((await catalog.selectSystemPrompt(created.value.ref, null)).status !== 'selected')
        return evaluate('setup_failed');

      const preparation = createContextPreparation({
        storage,
        ...(addressPreferences ? { addressForm: addressPreferences.resolve } : {}),
        ...(passport ? { passport: { read: passport.read, current: passport.current } } : {}),
        ...(persona?.profile ? { participantCards: contextParticipantCards(storage) } : {}),
        config: {
          modelContextTokens: 16_000,
          ...(scenario.historyLimit ? { maxHistoryMessages: scenario.historyLimit } : {}),
        },
        capabilities: (scope) => historyEvaluationAdapter.capabilities({ chatId: scope.chatId }),
        now: () => (scenario.historyTimezone ? scenario.input.timestamp : 0),
        sessionId: () => 'synthetic-eval-session',
      });
      const publication = createPublicationService({
        storage,
        ...(addressPreferences ? { addressCurrent: addressPreferences.current } : {}),
        ...(gateSettings ? { responseBudget: () => queue.responseBudget } : {}),
        port: {
          async canReply() {
            return true;
          },
          async publish(message) {
            if (message.beforeSend && !message.beforeSend()) return { kind: 'failed' };
            if (message.kind === 'answer') answer = message;
            return {
              kind: 'delivered',
              receipt: {
                messageId: 'published',
                userId: 'synthetic:bot',
                authorName: 'Бот',
                timestamp: gateSettings ? Date.now() : 200,
              },
            };
          },
        },
      });
      const settlement = Promise.withResolvers<QueueCompletion>();
      const admission = createLlmAdmission();
      const rate = responseRateConfig();
      let settledJobId: number | undefined;
      const queue: ChatQueue = createAgentLoopQueue({
        storage,
        ...(addressPreferences ? { addressCurrent: addressPreferences.current } : {}),
        tracing: { messageRetentionDays: 30 },
        modelName: settings.modelName ?? model,
        loopOptions: { timeoutMs, maxAttemptsPerStep: 1 },
        config: { handlerMarginMs, stopTimeoutMs: 1_000 },
        prepare: preparation.prepare,
        ...(scenario.historyTimezone || scenario.passport?.tryGrant || persona
          ? {
              tools: applicationTools(
                storage,
                historyEvaluationAdapter,
                { context: createContextAuthority('synthetic:owner').create },
                client,
              ),
              modelInputLimit: 16000 - preparation.config.maxOutputTokens,
            }
          : {}),
        ...(gateSettings
          ? {
              autonomousReplies: true,
              tokenBudget: true,
              groupReplyGate: true,
              llmAdmission: admission,
              responseRate: rate,
            }
          : {}),
        client: {
          async complete(input) {
            firstRequest ??= input;
            request = input;
            if (!gateSettings) return client.complete(input);
            mainStartMs ??= Math.round(performance.now() - admittedAt);
            return mainMeter.measure(() => client.complete(input));
          },
        },
        async onSettled(work, completion) {
          settledJobId = work.jobId;
          try {
            await publication.onSettled(work, completion);
          } finally {
            settlement.resolve(completion);
          }
        },
      });
      const gateStop = new AbortController();
      let gateWork: Promise<void> | undefined;
      try {
        stage = 'processing_failed';
        await queue.start();
        const gate =
          gateSettings &&
          createGroupReplyGate({
            storage,
            admission,
            current: queue.isRunning,
            policy: { limits: chatLimits(), responseRate: rate },
            platform: 'synthetic',
            scope: lifecycle.admissionScope,
            sessionId: () => 'synthetic-group-reply',
            signal: gateStop.signal,
            promote: queue.promoteGroupReply!,
            client: {
              async complete(input) {
                const result = await gateMeter.measure(
                  () =>
                    settings.groupReplyClient?.complete(input) ??
                    Promise.resolve({
                      kind: 'complete',
                      text: gateSettings.expected === 'answer' ? 'ответить' : 'промолчать',
                      usage: { input: 0, output: 0 },
                    }),
                );
                const decision = groupReplyDecision(result);
                gateChoice = decision === 'answer' || decision === 'silence' ? decision : 'failed';
                if (decision === 'failed')
                  gateFailure = result.kind === 'error' ? result.code : 'group_reply_failed';
                return result;
              },
            },
          });
        const router = createMessageRouter({
          storage,
          queue,
          ...(gate ? { groupReplyGate: gate.allowInitiative } : {}),
        });
        admittedAt = performance.now();
        const routed = await router.receive(
          scope,
          stimulus,
          undefined,
          undefined,
          gate ? () => ({ ...disclosureStore(storage).gate(scope), respond: true }) : undefined,
        );
        if (routed.admission?.status === 'not_needed' && gate) {
          if (routed.decision?.kind !== 'assessment') return evaluate(null);
          for (const message of gateSettings?.after ?? [])
            await storage.messages.append(scope, {
              ...message,
              timestamp: Date.now(),
            });
          gateWork = gate.run();
          const id = routed.admission.messageId;
          const deadline = performance.now() + timeoutMs;
          while (performance.now() < deadline) {
            const item = groupReplyGateStore(storage).valid(scope, id, Date.now());
            if (item?.state === 'queued') break;
            if (item?.state === 'finished') return evaluate(gateFailure);
            await delay(5);
          }
          if (gateFailure) return evaluate(gateFailure);
          if (groupReplyGateStore(storage).valid(scope, id, Date.now())?.state !== 'queued')
            return evaluate('settlement_timeout');
        } else if (routed.admission?.status !== 'queued') return evaluate('not_queued');
        const completion = await waitForSettlement(settlement.promise, timeoutMs);
        if (!completion) return evaluate('settlement_timeout');
        const jobId = routed.admission?.status === 'queued' ? routed.admission.jobId : settledJobId;
        if (jobId === undefined) return evaluate('trace_missing');
        trace = await storage.traces.get(scope, jobId);
        if (!trace) return evaluate('trace_missing');
        if (beforeGrant) {
          const after = await storage.authorization.transaction(scope, (tx) =>
            tx.bases(stimulus.userId),
          );
          grantsUnchanged =
            beforeGrant.length === after.length &&
            beforeGrant.every((basis) => after.includes(basis));
        }
        return evaluate(classifyFailure(completion, trace));
      } finally {
        gateStop.abort();
        await gateWork;
        await queue.stop();
      }
    } finally {
      await storage.close();
    }
  } catch {
    return evaluate(stage);
  }
}

function defaultClient(scenario: Scenario): LlmClient {
  if (scenario.historySearch) return historySearchClient;
  if (scenario.historyTimezone) return yesterdayClient;
  if (scenario.passport?.tryGrant || scenario.persona?.profile)
    return deniedGrantClient(scenario.answer);
  return {
    async complete() {
      return {
        kind: 'complete',
        text: scenario.answer,
        usage: { input: null, output: null },
      };
    },
  };
}

export async function runLocalChatSummary(): Promise<EvaluationResult> {
  const result = await evaluateChatSummary(
    {
      async complete(request) {
        const { parts } = JSON.parse(request.messages[0]!.text!) as { parts: string[] };
        const text = parts
          .map((part) => {
            if (!part.startsWith('{')) return part;
            const row = JSON.parse(part) as { author: string; text: string };
            return row.author + ' — ' + row.text;
          })
          .join(' ');
        return { kind: 'complete', text, usage: { input: null, output: null } };
      },
    },
    AbortSignal.timeout(5000),
  );
  const outcome = result.passed ? 'passed' : 'failed';
  return {
    scenarioId: chatSummaryCase.id,
    scenarioRevision: chatSummaryCase.revision,
    model,
    prompt: { area: 'global', kind: 'system_prompt', key: 'chat-summary', version: 1 },
    outcome,
    reason: null,
    criteria: summaryFactChecks(result.text).map(({ id, matches }) => ({
      id,
      outcome: matches ? 'passed' : 'failed',
      reason: matches ? 'matched' : 'mismatch',
    })),
  };
}
