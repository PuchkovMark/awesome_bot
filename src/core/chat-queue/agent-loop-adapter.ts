import {
  composeSummaries,
  type ContextSummary,
  type PreparedSummaries,
} from '../context/summaries';
import type { PassportRevision, PassportSection } from '../../contracts/chat-passport';
import { composePassport, type PreparedPassport } from '../context/passport';
import {
  createParticipantCardComposer,
  type PreparedCards,
  type UsedCard,
  type CardReference,
} from '../context/participant-cards';
import { estimateRequestInput } from '../context/budget';
import type { AddressPreferenceReference, ConnectionScope, UserId } from '../../contracts/index';
import { createJobModelAttempts } from './delegated-attempts';
import type { LlmClient, LlmMessage } from '../../llm/types';
import type { AgentLoopInput, AgentLoopOptions, LoopTools } from '../agent-loop/types';
import { createAttemptSummary } from '../agent-loop/summary';
import { createAgentLoop } from '../agent-loop/service';
import { loopOptions } from '../agent-loop/validation';
import { createChatQueue } from './service';
import { queueConfig } from './validation';
import { QueueError } from './errors';
import type { ChatQueueOptions, QueueHandlerInput, QueueConfig, QueueCompletion } from './types';
import type { PreparationResult } from '../context/types';
import type { LlmAdmission } from '../llm-admission';
export type QueuePreparation =
  | {
      readonly kind: 'ready';
      readonly input: Omit<AgentLoopInput, 'signal'>;
      readonly metadata?: import('../context/types').ContextMetadata;
      readonly timezone?: string;
      readonly authorLabels?: readonly string[];
      readonly addressPreference?: AddressPreferenceReference;
      readonly participantCards?: PreparedCards;
      readonly passport?: PreparedPassport;
      readonly summaries?: PreparedSummaries;
    }
  | Exclude<PreparationResult, { kind: 'ready' }>;
export interface AgentLoopQueueOptions extends Omit<ChatQueueOptions, 'handler' | 'config'> {
  readonly tools?: (input: {
    modelInputLimit?: number;
    work: QueueHandlerInput;
    prepared: Extract<QueuePreparation, { kind: 'ready' }>;
    client: LlmClient;
    attempts: ReturnType<typeof createJobModelAttempts>;
    settings: Required<AgentLoopOptions>;
  }) => Promise<LoopTools | undefined>;
  readonly modelInputLimit?: number;
  readonly recapAnswer?: (work: QueueHandlerInput) => Promise<QueueCompletion | null>;
  readonly questionnaireAnswer?: (work: QueueHandlerInput) => Promise<QueueCompletion | null>;
  readonly modelName: string;
  readonly client: LlmClient;
  readonly llmAdmission?: LlmAdmission;
  readonly loopOptions?: AgentLoopOptions;
  readonly config?: Omit<Partial<QueueConfig>, 'loopTimeoutMs'>;
  readonly preparationTimeoutMs?: number;
  readonly postPreparationMarginMs?: number;
  readonly signal?: AbortSignal;
  readonly prepare: (work: QueueHandlerInput) => Promise<QueuePreparation>;
  readonly addressCurrent?: (
    scope: ConnectionScope,
    reference: AddressPreferenceReference,
  ) => boolean;
  readonly disclosure?: (
    work: QueueHandlerInput,
  ) => import('../../storage/trace-types').TracePayload['disclosure'];
}
export function createAgentLoopQueue(options: AgentLoopQueueOptions) {
  const settings = loopOptions(options.loopOptions ?? {});
  if (
    typeof options.modelName !== 'string' ||
    !options.modelName.trim() ||
    Buffer.byteLength(options.modelName) > 1024
  )
    throw new TypeError('Tracing: invalid_configuration');
  const modelName = options.modelName,
    client = { complete: options.client.complete.bind(options.client) };
  const prep = options.preparationTimeoutMs ?? 2000,
    margin = options.postPreparationMarginMs ?? 1000;
  const config = queueConfig({ ...options.config, loopTimeoutMs: settings.timeoutMs });
  if (
    !Number.isSafeInteger(prep) ||
    prep <= 0 ||
    prep > 2147483647 ||
    !Number.isSafeInteger(margin) ||
    margin <= 0 ||
    config.handlerTimeoutMs < settings.timeoutMs + prep + margin
  )
    throw new QueueError('invalid_input');
  return createChatQueue({
    tracing: options.tracing,
    storage: options.storage,
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.onSettled ? { onSettled: options.onSettled } : {}),
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
    config,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.responseRate === undefined ? {} : { responseRate: options.responseRate }),
    ...(options.tokenBudget ? { tokenBudget: true } : {}),
    ...(options.autonomousReplies ? { autonomousReplies: true } : {}),
    handler: async (work) => {
      const zero = createAttemptSummary().snapshot(0);
      work.recordTrace({ summary: zero });
      const initialDisclosure = options.disclosure?.(work);
      if (initialDisclosure && !initialDisclosure.allowed) {
        work.recordTrace({ disclosure: initialDisclosure });
        return 'interrupted';
      }
      const lifetime = options.signal
        ? AbortSignal.any([work.signal, options.signal])
        : work.signal;
      const questionnaire = await options.questionnaireAnswer?.({ ...work, signal: lifetime });
      if (questionnaire) return questionnaire;
      const recap = await options.recapAnswer?.({ ...work, signal: lifetime });
      if (recap) return recap;
      const preparationDeadline = performance.now() + prep;
      async function prepare(): Promise<QueuePreparation> {
        const remaining = preparationDeadline - performance.now();
        if (remaining <= 0) return { kind: 'deadline_exceeded' };
        const controller = new AbortController(),
          signal = AbortSignal.any([lifetime, controller.signal]);
        let abort: () => void = () => {};
        const interrupted = new Promise<QueuePreparation>((resolve) => {
          abort = () => resolve({ kind: lifetime.aborted ? 'cancelled' : 'deadline_exceeded' });
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        });
        const timer = setTimeout(() => controller.abort(), Math.ceil(remaining));
        try {
          return await Promise.race([
            Promise.resolve().then(() =>
              signal.aborted
                ? { kind: 'cancelled' as const }
                : options.prepare({ ...work, signal }),
            ),
            interrupted,
          ]);
        } finally {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
        }
      }
      for (;;) {
        const prepared = await prepare();
        if (lifetime.aborted || !work.isCurrent()) return 'interrupted';
        if (prepared.kind === 'cancelled') return 'interrupted';
        if (prepared.kind === 'deadline_exceeded') return 'deadline_exceeded';
        if (prepared.kind === 'unavailable') return 'message_missing';
        if (prepared.kind === 'failed') {
          const allowed = [
            'missing_system_prompt',
            'static_budget_too_small',
            'current_message_too_large',
            'internal_error',
          ];
          return {
            outcome: 'failed',
            ...(allowed.includes(prepared.reason) ? { preparationFailure: prepared.reason } : {}),
          } satisfies QueueCompletion;
        }
        if (prepared.kind !== 'ready') return 'failed';
        // Финальная синхронная проверка выполняется непосредственно перед запуском цикла.
        if (!work.isCurrent() || lifetime.aborted) return 'interrupted';
        const baseContext = prepared.metadata && { ...prepared.metadata };
        const persona = baseContext?.persona;
        if (baseContext && persona) {
          delete baseContext.persona;
          baseContext.absentLayers = [...baseContext.absentLayers, 'persona'];
        }
        work.recordTrace({
          prompt: prepared.metadata?.version ?? null,
          context: baseContext ?? null,
        });
        const cards = prepared.participantCards;
        const compose = cards
          ? createParticipantCardComposer(cards, options.modelInputLimit)
          : undefined;
        const passport = prepared.passport;
        const summaries = prepared.summaries;
        const usedSummaries = new Map<number, ContextSummary>();
        let candidateSummaries: readonly ContextSummary[] = [];
        const summaryCurrent = () =>
          summaries?.current([...usedSummaries.keys(), ...candidateSummaries.map((s) => s.id)]) ??
          true;
        const messageIndex = prepared.input.messages.length - 1;
        const usedRefs = new Map<CardReference['value'], CardReference>();
        const cardSubjects = new Set<UserId>();
        const cardSources = new Set<number>();
        let candidateCards: readonly UsedCard[] = [];
        const usedPassport = new Map<PassportSection, PassportRevision>();
        let candidatePassport: ReturnType<typeof composePassport> | undefined;
        let passportBase: LlmMessage | undefined;
        let passportTokens = 0;
        let addedBytes = 0;
        let context = baseContext;
        let staleContext = false;
        let attempted = false;
        const cardsCurrent = () => cards?.current([...usedRefs.values()]) ?? true;
        const passportCurrent = (extra: readonly PassportRevision[] = []) => {
          try {
            return passport?.current([...usedPassport.values(), ...extra]) ?? true;
          } catch {
            return false;
          }
        };
        const allowed = () => {
          if (
            (cards &&
              !cards.current([
                ...usedRefs.values(),
                ...candidateCards.flatMap(({ refs }) => refs),
              ])) ||
            !summaryCurrent() ||
            !passportCurrent(attempted ? candidatePassport?.used : passport?.entries)
          ) {
            staleContext = true;
            return false;
          }
          if (
            lifetime.aborted ||
            (session && !session.current()) ||
            (prepared.addressPreference &&
              options.addressCurrent?.(work.scope, prepared.addressPreference) !== true)
          )
            return false;
          const checked = options.disclosure?.(work);
          if (checked) work.recordTrace({ disclosure: checked });
          return checked?.allowed ?? true;
        };
        const jobAttempts = createJobModelAttempts(work, allowed, options.llmAdmission);
        const session: LoopTools | undefined = await options.tools?.({
          work,
          prepared,
          client,
          ...(options.modelInputLimit ? { modelInputLimit: options.modelInputLimit } : {}),
          attempts: jobAttempts,
          settings,
        });
        const guardedSession: LoopTools | undefined =
          session && (cards || passport || summaries)
            ? {
                ...session,
                current: () =>
                  session.current() && cardsCurrent() && passportCurrent() && summaryCurrent(),
                ...(passport || summaries
                  ? {
                      beginBatch(request, remaining, steps, isLoopCurrent) {
                        // Результат инструмента использует место до добавления необязательных разделов.
                        if (!passportBase)
                          return session.beginBatch(request, remaining, steps, isLoopCurrent);
                        const messages = request.messages.slice();
                        messages[messageIndex] = passportBase;
                        session.beginBatch(
                          { ...request, messages },
                          remaining,
                          steps,
                          isLoopCurrent,
                        );
                      },
                    }
                  : {}),
              }
            : session;
        const loop = createAgentLoop(
          client,
          settings,
          (summary) =>
            work.recordTrace({ model: { name: modelName, invoked: 'possible' }, summary }),
          (request) => {
            if (options.modelInputLimit && estimateRequestInput(request) > options.modelInputLimit)
              return 'token_budget_exhausted';
            const ids = [
              ...new Set([...(context?.messageIds ?? []), ...(session?.sourceIds() ?? [])]),
            ];
            if (context && session && (session.sourceIds().length || session.trace().length))
              work.recordTrace({
                context: { ...context, messageIds: ids },
                tools: session.trace(),
              });
            const admission =
              options.tokenBudget && work.route
                ? jobAttempts.reserve(
                    request,
                    ids,
                    session && request.messages.some((m) => m.role === 'tool')
                      ? 'consume'
                      : undefined,
                  )
                : work.admitModelAttempt
                  ? work.admitModelAttempt(allowed, ids)
                  : work.isCurrent() && allowed();
            if (admission === 'context_stale') staleContext = true;
            if (admission === true || (admission !== null && typeof admission === 'object')) {
              attempted = true;
              for (const s of candidateSummaries) usedSummaries.set(s.id, s);
              for (const card of candidateCards) {
                cardSubjects.add(card.owner);
                for (const id of card.sourceIds) cardSources.add(id);
                for (const ref of card.refs) usedRefs.set(ref.value, ref);
              }
              for (const revision of candidatePassport?.used ?? [])
                usedPassport.set(revision.section, revision);
              if (
                context &&
                baseContext &&
                ((persona && !context.persona) ||
                  candidateCards.length ||
                  candidatePassport?.used.length ||
                  candidateSummaries.length)
              ) {
                const index = messageIndex;
                const original = baseContext;
                addedBytes = Math.max(
                  addedBytes,
                  Buffer.byteLength(request.messages[index]?.text ?? '') -
                    Buffer.byteLength(prepared.input.messages[index]?.text ?? ''),
                );
                passportTokens = Math.max(passportTokens, candidatePassport?.estimatedTokens ?? 0);
                context = {
                  ...original,
                  ...(persona ? { persona } : {}),
                  layerBytes: {
                    ...original.layerBytes,
                    messages: original.layerBytes.messages + addedBytes,
                  },
                  estimatedTokens: original.estimatedTokens + addedBytes,
                  absentLayers: original.absentLayers.filter(
                    (layer) =>
                      !(layer === 'persona' && persona) &&
                      !(layer === 'profiles' && cardSubjects.size) &&
                      !(layer === 'passport' && usedPassport.size) &&
                      !(layer === 'summaries' && usedSummaries.size),
                  ),
                  ...(usedSummaries.size
                    ? {
                        summaries: [...usedSummaries.values()].map(({ id, level, text }) => ({
                          id,
                          level,
                          bytes: Buffer.byteLength(text),
                        })),
                      }
                    : {}),
                  ...(usedPassport.size
                    ? {
                        passport: {
                          sections: [...usedPassport.keys()],
                          estimatedTokens: passportTokens,
                        },
                      }
                    : {}),
                };
                work.recordTrace({ context: { ...context, messageIds: ids } });
              }
              candidateSummaries = [];
              candidatePassport = undefined;
              candidateCards = [];
            }
            return admission;
          },
          guardedSession,
          compose || passport || summaries
            ? (request) => {
                const result = compose?.(request);
                candidateCards = result?.used ?? [];
                const withCards = result?.request ?? request;
                const currentPassport =
                  passport && attempted
                    ? { ...passport, entries: passport.readEntries() }
                    : passport;
                candidatePassport = currentPassport
                  ? composePassport(currentPassport, withCards, options.modelInputLimit)
                  : undefined;
                const withPassport = candidatePassport?.request ?? withCards;
                const enriched = summaries
                  ? composeSummaries(
                      summaries.entries,
                      messageIndex,
                      withPassport,
                      Math.min(summaries.inputBudget, options.modelInputLimit ?? Infinity),
                    )
                  : undefined;
                candidateSummaries = enriched?.used ?? [];
                passportBase =
                  candidatePassport?.used.length || candidateSummaries.length
                    ? withCards.messages[messageIndex]
                    : undefined;
                return enriched?.request ?? withPassport;
              }
            : undefined,
          options.llmAdmission
            ? {
                admission: options.llmAdmission,
                ...(work.deadline === undefined ? {} : { deadline: work.deadline }),
                current: () => !lifetime.aborted && work.isCurrent(),
              }
            : undefined,
        );
        const result = await loop.run({ ...prepared.input, signal: lifetime });
        if (staleContext && result.summary.attempts === 0) continue;
        work.recordTrace({
          model: {
            name: result.summary.attempts ? modelName : null,
            invoked: result.summary.attempts ? 'yes' : 'no',
          },
          ...(session ? { tools: session.trace() } : {}),
          summary: result.summary,
          resultKind: result.kind,
        });
        const outcome =
          result.kind === 'complete'
            ? 'completed'
            : result.kind === 'rate_limit'
              ? 'rate_limit'
              : result.kind === 'deadline_exceeded'
                ? 'deadline_exceeded'
                : result.kind === 'cancelled'
                  ? 'interrupted'
                  : 'failed';
        return {
          outcome,
          result,
          ...(prepared.addressPreference ? { addressPreference: prepared.addressPreference } : {}),
          ...(session || usedSummaries.size
            ? {
                toolResultsCurrent: () => (session?.current() ?? true) && summaryCurrent(),
                toolSourceIds: [
                  ...new Set([
                    ...(session?.sourceIds() ?? []),
                    ...[...usedSummaries.values()].flatMap((s) => s.ids),
                  ]),
                ],
              }
            : {}),
          ...(usedPassport.size ? { passportCurrent: () => passportCurrent() } : {}),
          ...(cardSubjects.size
            ? { participantCards: { current: cardsCurrent, sourceIds: [...cardSources] } }
            : {}),
          subjectIds: [...new Set([...(session?.subjectIds?.() ?? []), ...cardSubjects])],
          authorLabels: [...(prepared.authorLabels ?? []), ...(session?.labels() ?? [])],
        };
      }
    },
  });
}
