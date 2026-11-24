import type { AddressPreferenceReference } from '../../contracts/index';
import { personalDataStore } from '../../storage/personal-data-store';
import { isRateLimitedNotice } from '../../storage/notice-types';
import type { ConnectionScope, PublishedPart } from '../../contracts/index';
import type { Storage } from '../../storage/index';
import type {
  FloodNotice,
  ResponsePublication,
  ResponsePublicationAdmission,
  ResponsePublicationBudget,
  RouteMetadata,
} from '../../storage/queue-types';
import type { QueueCompletion, QueueSettlement } from '../chat-queue/types';
import type { NoticeReceipt, NoticePermit } from '../../storage/notice-types';
import type { TracePublication } from '../../storage/trace-types';
import { traceBackend } from '../../storage/trace-store';
import { noticeBackend } from '../../storage/notice-store';
import { lifecycleBackend } from '../../storage/lifecycle-store';
import {
  beginMeasuredPublication,
  confirmMeasuredPart,
  finishMeasuredPublication,
  type DeliveryOutcome,
} from '../../storage/chat-request-metrics-store';
import { noticeInterval } from './notice-config';
import { publicationDecision, publicationRow, noticeTemplate } from './publication';
import { disclosesAuthorLabel } from './author-label-disclosure';
import { questionnaireAccessQuestion } from '../questionnaire/answer';
import { questionnaireAccessStore } from '../../storage/questionnaire-access-store';
import {
  questionnairePresentationStore,
  type QuestionnairePresentationGrant,
  type QuestionnairePresentationTarget,
} from '../../storage/questionnaire-presentation-store';
import { questionnaireViewStore } from '../../storage/questionnaire-view-store';
import { questionnaireListText, questionnairePresentationQuestion } from '../questionnaire/text';
export interface PublicationGuard {
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
  readonly allow: () => Promise<boolean>;
}
export interface PublicationRequest extends PublicationGuard {
  readonly scope: ConnectionScope;
  readonly kind: 'answer' | 'notice';
  readonly text: string;
  readonly replyToMessageId?: string;
  readonly beforeSend?: () => boolean;
  readonly confirmPart: (part: PublishedPart, last?: true) => void;
}
export type PublicationResult =
  | { readonly kind: 'delivered'; readonly receipt: NoticeReceipt }
  | { readonly kind: 'delivered'; readonly confirmedParts: number }
  | { readonly kind: 'failed' | 'unknown'; readonly confirmedParts?: number };
export interface PublicationPort {
  canReply(
    scope: ConnectionScope,
    signal: AbortSignal,
    sourceId?: string,
    guard?: PublicationGuard,
  ): Promise<boolean>;
  publish(input: PublicationRequest): Promise<PublicationResult>;
}
type PublicationFailure =
  'publication_failed' | 'journal_failed' | 'trace_write_failed' | 'partial_delivery';
async function bounded<T>(signal: AbortSignal, promise: Promise<T>): Promise<T | null> {
  if (signal.aborted) {
    void promise.catch(() => {});
    return null;
  }
  let abort: () => void = () => {};
  const interrupted = new Promise<null>((resolve) => {
    abort = () => resolve(null);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([promise, interrupted]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
export function createPublicationService(options: {
  readonly storage: Storage;
  readonly port?: PublicationPort;
  readonly noticeIntervalMs?: number;
  readonly queueFullTimeoutMs?: number;
  readonly onFailure?: (code: PublicationFailure) => void;
  readonly disclosureCurrent?: (work: QueueSettlement) => boolean;
  readonly addressCurrent?: (
    scope: ConnectionScope,
    reference: AddressPreferenceReference,
  ) => boolean;
  readonly responseBudget?: () => ResponsePublicationBudget | undefined;
}) {
  const fullTimeout = noticeInterval(options.queueFullTimeoutMs ?? 10000);
  if (fullTimeout > 2147483647) throw new TypeError('Router: invalid_configuration');
  const interval = noticeInterval(options.noticeIntervalMs),
    notices = noticeBackend(options.storage),
    traces = traceBackend(options.storage);
  const lifecycle = lifecycleBackend(options.storage);
  const questionnaireAccess = questionnaireAccessStore(options.storage);
  const questionnairePresentations = questionnairePresentationStore(options.storage);
  const questionnaireViews = questionnaireViewStore(options.storage);
  const counters = {
    publication_failed: 0,
    journal_failed: 0,
    trace_write_failed: 0,
    partial_delivery: 0,
  };
  const report = (code: keyof typeof counters) => {
    counters[code] = Math.min(Number.MAX_SAFE_INTEGER, counters[code] + 1);
    try {
      options.onFailure?.(code);
    } catch {
      /* Диагностика не меняет исход. */
    }
  };
  const active = new Set<number>();
  async function publish(
    work: QueueSettlement,
    outcome: unknown,
    details: {
      readonly subjectIds?: readonly import('../../contracts/index').UserId[];
      readonly withoutJob?: boolean;
      readonly flood?: FloodNotice;
      readonly authorLabels?: readonly string[];
      readonly addressPreference?: AddressPreferenceReference;
      readonly participantCards?: QueueCompletion['participantCards'];
      readonly passportCurrent?: QueueCompletion['passportCurrent'];
      readonly toolSourceIds?: readonly number[];
      readonly toolResultsCurrent?: QueueCompletion['toolResultsCurrent'];
      readonly questionnaireAccess?: QueueCompletion['questionnaireAccess'];
    } = {},
  ): Promise<string> {
    const {
      withoutJob = false,
      flood,
      authorLabels = [],
      addressPreference,
      participantCards,
      passportCurrent,
      toolResultsCurrent,
    } = details;
    const jobId = work.jobId;
    if (!withoutJob && (jobId === undefined || active.has(jobId))) return 'silence';
    if (jobId !== undefined) active.add(jobId);
    let permit: NoticePermit | undefined,
      traceFailed = false;
    let scope = work.scope,
      closed = false;
    let budget: ResponsePublicationBudget | undefined,
      meter: ResponsePublication | undefined,
      started = false;
    let measuredJob: number | undefined;
    let measurementStarted = false;
    let deliveryOutcome: DeliveryOutcome | undefined;
    function measureStart(db: Parameters<typeof beginMeasuredPublication>[0]) {
      if (measuredJob === undefined || measurementStarted) return;
      beginMeasuredPublication(db, scope, measuredJob);
      measurementStarted = true;
      deliveryOutcome ??= 'unknown';
    }
    let preferenceDenied = false;
    let contextDenied = false;
    let meteredOutcome: import('../../storage/response-rate-store').ResponseRateOutcome = 'unknown';
    const denial: { reason?: Extract<ResponsePublicationAdmission, { allowed: false }>['reason'] } =
      {};
    const rowId = publicationRow(work.route, outcome);
    const save = (pub: TracePublication): boolean => {
      if (withoutJob) return true;
      if (jobId === undefined) return false;
      // Ревизия запрещает отправку. Итог допуска относится к тому же поколению.
      let traceScope: ConnectionScope;
      try {
        traceScope = lifecycle.current(scope.chatId);
        if (traceScope.generation !== scope.generation) return false;
      } catch {
        return false;
      }
      try {
        if (traces.publication(traceScope, jobId, pub)) return true;
      } catch {
        /* Попытка минимальной формы ниже. */
      }
      traces.report('full_write_failed');
      try {
        if (traces.publication(traceScope, jobId, pub, true)) {
          traces.report('minimal_saved');
          return true;
        }
      } catch {
        /* Текст ошибки не читается. */
      }
      if (!traceFailed) {
        traceFailed = true;
        traces.report('trace_write_failed');
        report('trace_write_failed');
      }
      return false;
    };
    const suppressed = (reason: TracePublication['reason']) => {
      save({ rowId, tableVersion: 1, reaction: 'silence', status: 'suppressed', reason });
      return 'silence';
    };
    try {
      if (!withoutJob) {
        const row = traces.get(work.scope, jobId);
        if (!row || row.finishedAt === null || row.payload.publication.status !== 'pending_checks')
          return 'silence';
      }
      const route = work.route;
      if (!route || work.signal.aborted || !work.isCurrent()) return suppressed('guard');
      if (!options.port) return suppressed('no_port');
      budget = route.isGroupChat ? options.responseBudget?.() : undefined;
      if (route.kind === 'initiative' && !budget?.confirmInitiative) return suppressed('guard');
      if (flood && !budget) return suppressed('guard');
      scope = lifecycle.transaction(work.scope, () => lifecycle.current(work.scope.chatId, true));
      const addressCurrent = () => {
        if (!addressPreference) return true;
        try {
          const current = lifecycle.current(scope.chatId);
          return (
            current.generation === scope.generation &&
            options.addressCurrent?.(current, addressPreference) === true
          );
        } catch {
          return false;
        }
      };
      const contextCurrent = () => {
        try {
          return (
            (participantCards?.current() ?? true) &&
            (toolResultsCurrent?.() ?? true) &&
            (passportCurrent?.() ?? true)
          );
        } catch {
          return false;
        }
      };
      const guardReason = () =>
        addressCurrent() ? ('guard' as const) : ('address_preference_changed' as const);
      function isCurrent(): boolean {
        if (closed || work.signal.aborted || !work.isCurrent()) return false;
        try {
          lifecycle.revision(scope);
          return (
            (!withoutJob || notices.sourceVisible(scope, work.messageId)) &&
            (options.disclosureCurrent?.(work) ?? true)
          );
        } catch {
          return false;
        }
      }
      const readyToSend = () => isCurrent() && addressCurrent() && contextCurrent();
      const settings = await options.storage.chats.get(scope);
      if (!settings || !readyToSend()) return suppressed(guardReason());
      let decision = publicationDecision(route, settings, outcome);
      if (decision.kind === 'silence') return suppressed('none');
      const guard: PublicationGuard = {
        signal: work.signal,
        isCurrent,
        async allow() {
          if (!isCurrent() || !contextCurrent()) return false;
          const latest = await options.storage.chats.get(scope);
          return (
            !!latest &&
            isCurrent() &&
            contextCurrent() &&
            publicationDecision(
              route,
              latest,
              traceFailed ? { kind: 'trace_write_failed' } : outcome,
            ).kind === decision.kind
          );
        },
      };
      const source = await options.storage.messages.get(scope, work.messageId);
      if (!source || !readyToSend()) return suppressed(guardReason());
      if (
        decision.kind === 'answer' &&
        route.isGroupChat &&
        disclosesAuthorLabel(decision.text, source.text, authorLabels)
      )
        return suppressed('author_label_disclosure');
      const reply = await bounded(
        work.signal,
        options.port.canReply(scope, work.signal, source.messageId, guard),
      );
      if (!readyToSend()) return suppressed(guardReason());
      const current = await options.storage.chats.get(scope);
      if (
        !current ||
        publicationDecision(route, current, outcome).kind !== decision.kind ||
        !readyToSend()
      )
        return suppressed(guardReason());
      // Проверка после await защищает и от второго экземпляра сервиса в одном процессе.
      if (!withoutJob && traces.get(scope, jobId)?.payload.publication.status !== 'pending_checks')
        return 'silence';
      if (decision.kind === 'notice' && reply !== true) return suppressed('no_reply');
      if (decision.kind === 'notice' && (!budget || !isRateLimitedNotice(decision.template))) {
        permit =
          notices.reserve(
            scope,
            work.messageId,
            route,
            interval,
            Date.now(),
            decision.template ?? 'generic',
          ) ?? undefined;
        if (!permit) return suppressed('notice_period');
      }
      const saved = save({
        rowId,
        tableVersion: 1,
        reaction: decision.kind,
        status: 'allowed',
        reason: 'none',
      });
      if (!saved) {
        if (route.kind === 'initiative') return 'silence';
        decision = publicationDecision(route, current, { kind: 'trace_write_failed' });
        if (decision.kind !== 'notice' || reply !== true) return 'silence';
        if (permit) notices.retarget(permit);
        else
          permit =
            notices.reserve(scope, work.messageId, route, interval, Date.now(), 'generic') ??
            undefined;
        if (!permit) return 'silence';
      }
      if (!(await guard.allow()) || !readyToSend()) return suppressed(guardReason());
      if (!withoutJob && decision.kind === 'answer') measuredJob = jobId;
      const notice =
        decision.kind === 'notice' && isRateLimitedNotice(decision.template)
          ? { kind: decision.template, interval }
          : undefined;
      if (budget && (decision.kind === 'answer' || notice)) {
        meter = {
          scope,
          messageId: work.messageId,
          key: flood ? `flood:${flood.messageId}` : `job:${jobId}`,
          route,
          ...(notice ? { notice } : {}),
          ...(flood ? { flood } : {}),
        };
      }
      const beforeSend = () => {
        if (!isCurrent()) return false;
        if (!contextCurrent()) {
          contextDenied = true;
          return false;
        }
        if (!addressCurrent()) {
          preferenceDenied = true;
          return false;
        }
        if (budget && meter && started) {
          if (route.kind === 'initiative') budget.repeatInitiative?.(meter);
          return !flood || budget.currentFlood(meter);
        }
        if (budget && meter) {
          const admission = budget.start(meter, isCurrent);
          if (!admission.allowed) {
            denial.reason = admission.reason;
            return false;
          }
          permit = admission.permit;
          started = true;
        }
        if (measuredJob !== undefined && !measurementStarted)
          lifecycle.transaction(scope, measureStart);
        return true;
      };
      const text =
        decision.kind === 'notice'
          ? noticeTemplate(traceFailed ? 'generic' : (decision.template ?? 'generic'))
          : decision.text;
      const replyToMessageId = reply === true ? source.messageId : undefined;
      const replyFields = replyToMessageId === undefined ? {} : { replyToMessageId };
      const parts = new Set<string>();
      let journalFailed = false,
        accepting = true;
      const confirmPart = (part: PublishedPart, last?: true): void => {
        if (!accepting || !isCurrent() || journalFailed)
          throw new Error('Publication: confirmation no longer current');
        try {
          const { messageId, userId, authorName, timestamp } = part;
          const receipt = { messageId, userId, authorName, timestamp };
          const samePart = parts.has(messageId);
          if (meter && !started) throw new Error('Publication: missing send admission');
          if (
            part.replyToMessageId !== undefined &&
            (part.replyToMessageId !== replyToMessageId || (!samePart && parts.size > 0))
          )
            throw new Error('Publication: invalid reply');
          lifecycle.transaction(scope, (db) => {
            if (permit) {
              if (
                part.replyToMessageId !== replyToMessageId ||
                replyToMessageId === undefined ||
                (!samePart && parts.size > 0)
              )
                throw new Error('Publication: invalid notice');
              notices.confirm(scope, permit, receipt, part.text, isCurrent);
            } else if (route.kind === 'initiative') {
              if (!meter || !budget?.confirmInitiative)
                throw new Error('Publication: missing initiative admission');
              budget.confirmInitiative(meter, receipt, part.text, part.replyToMessageId, isCurrent);
            } else {
              notices.recordAnswer(scope, receipt, part.text, part.replyToMessageId, isCurrent);
              if (details.questionnaireAccess && part.text.includes(questionnaireAccessQuestion))
                questionnaireAccess.confirmPrompt(
                  scope,
                  details.questionnaireAccess.user,
                  details.questionnaireAccess.attempt,
                  messageId,
                  Date.now(),
                );
            }
            if (!permit) {
              const ids =
                (!withoutJob && traces.get(scope, jobId)?.payload.context?.messageIds) || [];
              personalDataStore(options.storage).recordAnswerSources(
                db,
                scope,
                messageId,
                [
                  ...new Set([
                    work.messageId,
                    ...ids,
                    ...(decision.kind === 'answer' ? (details.toolSourceIds ?? []) : []),
                    ...(decision.kind === 'answer' ? (participantCards?.sourceIds ?? []) : []),
                  ]),
                ],
                decision.kind === 'answer'
                  ? [
                      ...new Set([
                        ...(details.subjectIds ?? []),
                        ...(addressPreference ? [addressPreference.userId] : []),
                      ]),
                    ]
                  : undefined,
              );
            }
            if (measuredJob !== undefined) {
              measureStart(db);
              confirmMeasuredPart(db, scope, measuredJob, last === true && !samePart);
            }
          });
          parts.add(messageId);
        } catch {
          journalFailed = true;
          throw new Error('Publication: confirmation journal failed');
        }
      };
      let result: PublicationResult | null = null;
      try {
        result = await bounded(
          work.signal,
          options.port.publish({
            scope,
            kind: decision.kind,
            text,
            ...replyFields,
            ...guard,
            ...(meter ||
            measuredJob !== undefined ||
            addressPreference ||
            participantCards ||
            toolResultsCurrent ||
            passportCurrent
              ? { beforeSend }
              : {}),
            confirmPart,
          }),
        );
        if (result?.kind === 'delivered' && 'receipt' in result) {
          if (parts.size === 0) confirmPart({ ...result.receipt, text, ...replyFields }, true);
          else result = null;
        } else if (
          result?.kind === 'delivered' &&
          (result.confirmedParts !== parts.size || parts.size === 0)
        )
          result = null;
      } catch {
        result = null;
      } finally {
        accepting = false;
      }
      if (parts.size > 0) meteredOutcome = 'delivered';
      else if (!journalFailed && result?.kind === 'failed') meteredOutcome = 'failed';
      if (denial.reason && !started) return suppressed(denial.reason);
      if (parts.size === 0 && (contextDenied || !contextCurrent())) return suppressed('guard');
      if (
        parts.size === 0 &&
        (preferenceDenied || (result?.kind === 'failed' && !addressCurrent()))
      )
        return suppressed('address_preference_changed');
      deliveryOutcome = journalFailed ? 'unknown' : (result?.kind ?? 'unknown');
      if (journalFailed) {
        report('journal_failed');
        if (parts.size > 0) report('partial_delivery');
        if (!traceFailed)
          save({
            rowId,
            tableVersion: 1,
            reaction: decision.kind,
            status: 'unknown',
            reason: 'journal_failed',
          });
        return 'journal_failed';
      }
      if (result?.kind !== 'delivered') {
        report('publication_failed');
        if (parts.size > 0) report('partial_delivery');
        const status = result?.kind === 'failed' ? 'failed' : 'unknown';
        if (!traceFailed)
          save({
            rowId,
            tableVersion: 1,
            reaction: decision.kind,
            status,
            reason: parts.size > 0 ? 'partial_delivery' : 'publication_failed',
          });
        return status;
      }
      if (!traceFailed)
        save({
          rowId,
          tableVersion: 1,
          reaction: decision.kind,
          status: 'delivered',
          reason: 'none',
        });
      return 'delivered';
    } catch {
      report('publication_failed');
      return 'failed';
    } finally {
      closed = true;
      if (measuredJob !== undefined && deliveryOutcome !== undefined) {
        try {
          const job = measuredJob,
            outcome = deliveryOutcome;
          const current = lifecycle.current(scope.chatId);
          if (current.generation === scope.generation)
            lifecycle.transaction(current, (db) => {
              measureStart(db);
              finishMeasuredPublication(db, current, job, outcome);
            });
        } catch {
          /* Сохранённые подтверждения учитываются при восстановлении очереди. */
        }
      }
      if (started && budget && meter) {
        try {
          budget.finish(meter, meteredOutcome);
        } catch {
          /* При потере владения исход восстановится как неизвестный. */
        }
      }
      if (permit) notices.discard(permit);
      if (jobId !== undefined) active.delete(jobId);
    }
  }

  async function askForPresentation(
    work: QueueSettlement,
    target: QuestionnairePresentationTarget,
  ) {
    const { port } = options;
    if (!port || !work.route?.isGroupChat || work.signal.aborted || !work.isCurrent()) return;
    const scope = lifecycle.current(work.scope.chatId, true);
    const current = () => {
      try {
        return (
          !work.signal.aborted &&
          work.isCurrent() &&
          (options.disclosureCurrent?.(work) ?? true) &&
          questionnairePresentations.canPrompt(scope, target) &&
          Boolean(questionnaireViews.presentation(scope, target.user, Date.now())?.pairs.length)
        );
      } catch {
        return false;
      }
    };
    if (!current()) return;
    const source = await options.storage.messages.get(scope, work.messageId);
    if (!source || !current()) return;
    const guard = { signal: work.signal, isCurrent: current, allow: async () => current() };
    const reply = await bounded(
      work.signal,
      port.canReply(scope, work.signal, source.messageId, guard),
    );
    if (reply !== true || !current()) return;
    const text = questionnairePresentationQuestion;
    let confirmed = false;
    const confirmPart = (part: PublishedPart) => {
      if (!confirmed && part.text === text && part.replyToMessageId === source.messageId)
        confirmed = questionnairePresentations.confirmPrompt(scope, target, part);
    };
    const result = await bounded(
      work.signal,
      port.publish({
        ...guard,
        scope,
        kind: 'answer',
        text,
        replyToMessageId: source.messageId,
        beforeSend: current,
        confirmPart,
      }),
    );
    if (result?.kind === 'delivered' && 'receipt' in result)
      confirmPart({ ...result.receipt, text, replyToMessageId: source.messageId });
  }

  async function presentQuestionnaire(
    scope: ConnectionScope,
    grant: QuestionnairePresentationGrant,
    authorName: string,
    guard: PublicationGuard,
  ) {
    let outcome: 'failed' | 'unknown' | 'delivered' = 'failed';
    try {
      const { port } = options;
      const read = () => questionnaireViews.presentation(scope, grant.user, Date.now());
      if (!port || !guard.isCurrent()) return;
      const view = read();
      if (!view?.pairs.length || view.attempt !== grant.attempt) return;
      const current = () => {
        try {
          return (
            guard.isCurrent() &&
            questionnairePresentations.current(scope, grant) &&
            read()?.signature === view.signature
          );
        } catch {
          return false;
        }
      };
      const name = [...authorName.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim()]
        .slice(0, 120)
        .join('');
      const heading = name ? `Знакомьтесь, ${name}!` : 'Представление участника';
      const text = questionnaireListText(view.pairs, heading);
      const parts = new Set<string>();
      const confirmPart = (part: PublishedPart) => {
        if (parts.has(part.messageId)) return;
        questionnairePresentations.confirmPart(scope, grant, part);
        parts.add(part.messageId);
      };
      outcome = 'unknown';
      const result = await bounded(
        guard.signal,
        port.publish({
          ...guard,
          scope,
          kind: 'answer',
          text,
          isCurrent: current,
          allow: async () => current() && (await guard.allow()) && current(),
          beforeSend: current,
          confirmPart,
        }),
      );
      if (result?.kind === 'delivered' && 'receipt' in result && parts.size === 0)
        confirmPart({ ...result.receipt, text });
      if (
        result?.kind === 'delivered' &&
        parts.size > 0 &&
        (!('confirmedParts' in result) || result.confirmedParts === parts.size)
      )
        outcome = 'delivered';
      if (result?.kind === 'failed' && parts.size === 0) outcome = 'failed';
    } catch {
      report('publication_failed');
    } finally {
      try {
        const latest = lifecycle.current(scope.chatId);
        if (latest.generation === scope.generation)
          questionnairePresentations.finish(latest, grant, outcome);
      } catch {
        // Неизвестное состояние после потери подключения блокирует повторную отправку.
        report('publication_failed');
      }
    }
  }
  return Object.freeze({
    presentQuestionnaire,
    stats() {
      return Object.freeze({ ...counters });
    },
    async onSettled(work: QueueSettlement, completion: QueueCompletion) {
      const outcome = await publish(
        work,
        completion.preparationFailure
          ? { kind: completion.preparationFailure }
          : (completion.result ?? { kind: completion.outcome }),
        {
          toolSourceIds: completion.toolSourceIds ?? [],
          subjectIds: completion.subjectIds ?? [],
          ...(completion.questionnaireAccess
            ? { questionnaireAccess: completion.questionnaireAccess }
            : {}),
          ...(completion.participantCards ? { participantCards: completion.participantCards } : {}),
          ...(completion.passportCurrent ? { passportCurrent: completion.passportCurrent } : {}),
          ...(completion.toolResultsCurrent
            ? { toolResultsCurrent: completion.toolResultsCurrent }
            : {}),
          authorLabels: completion.authorLabels ?? [],
          ...(completion.addressPreference
            ? { addressPreference: completion.addressPreference }
            : {}),
        },
      );
      if (outcome === 'delivered' && completion.questionnaireAccess) {
        try {
          await askForPresentation(work, completion.questionnaireAccess);
        } catch {
          report('publication_failed');
        }
      }
    },
    async flood(
      scope: ConnectionScope,
      candidate: FloodNotice,
      guard: { readonly signal: AbortSignal; readonly isCurrent: () => boolean },
    ) {
      const remaining = candidate.receivedAt + fullTimeout - Date.now();
      if (remaining <= 0) return;
      const signal = AbortSignal.any([
        guard.signal,
        AbortSignal.timeout(Math.min(fullTimeout, remaining)),
      ]);
      const { messageId, route, disclosureVersion } = candidate;
      await publish(
        {
          scope,
          messageId,
          route,
          signal,
          isCurrent: () => !signal.aborted && guard.isCurrent(),
          ...(disclosureVersion === null ? {} : { disclosureVersion }),
        },
        { kind: 'mention_flood' },
        { withoutJob: true, flood: candidate },
      );
    },
    async queueFull(
      scope: ConnectionScope,
      messageId: number,
      route: RouteMetadata,
      guard: { readonly signal: AbortSignal; readonly isCurrent: () => boolean },
    ) {
      const signal = AbortSignal.any([guard.signal, AbortSignal.timeout(fullTimeout)]);
      await publish(
        { scope, messageId, route, signal, isCurrent: () => !signal.aborted && guard.isCurrent() },
        { kind: 'queue_full' },
        { withoutJob: true },
      );
    },
  });
}
