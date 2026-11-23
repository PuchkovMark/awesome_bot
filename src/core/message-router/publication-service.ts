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
import { noticeInterval } from './notice-config';
import { publicationDecision, publicationRow, noticeTemplate } from './publication';
import { disclosesAuthorLabel } from './author-label-disclosure';
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
  readonly confirmPart: (part: PublishedPart) => void;
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
  readonly responseBudget?: () => ResponsePublicationBudget | undefined;
}) {
  const fullTimeout = noticeInterval(options.queueFullTimeoutMs ?? 10000);
  if (fullTimeout > 2147483647) throw new TypeError('Router: invalid_configuration');
  const interval = noticeInterval(options.noticeIntervalMs),
    notices = noticeBackend(options.storage),
    traces = traceBackend(options.storage);
  const lifecycle = lifecycleBackend(options.storage);
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
      readonly withoutJob?: boolean;
      readonly flood?: FloodNotice;
      readonly authorLabels?: readonly string[];
    } = {},
  ): Promise<string> {
    const { withoutJob = false, flood, authorLabels = [] } = details;
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
    let meteredOutcome: import('../../storage/response-rate-store').ResponseRateOutcome = 'unknown';
    const denial: { reason?: Extract<ResponsePublicationAdmission, { allowed: false }>['reason'] } =
      {};
    const rowId = publicationRow(work.route, outcome);
    const save = (pub: TracePublication): boolean => {
      if (withoutJob) return true;
      if (jobId === undefined) return false;
      try {
        if (traces.publication(scope, jobId, pub)) return true;
      } catch {
        /* Попытка минимальной формы ниже. */
      }
      traces.report('full_write_failed');
      try {
        if (traces.publication(scope, jobId, pub, true)) {
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
      const settings = await options.storage.chats.get(scope);
      if (!settings || !isCurrent()) return suppressed('guard');
      let decision = publicationDecision(route, settings, outcome);
      if (decision.kind === 'silence') return suppressed('none');
      const guard: PublicationGuard = {
        signal: work.signal,
        isCurrent,
        async allow() {
          if (!isCurrent()) return false;
          const latest = await options.storage.chats.get(scope);
          return (
            !!latest &&
            isCurrent() &&
            publicationDecision(
              route,
              latest,
              traceFailed ? { kind: 'trace_write_failed' } : outcome,
            ).kind === decision.kind
          );
        },
      };
      const source = await options.storage.messages.get(scope, work.messageId);
      if (!source || !isCurrent()) return suppressed('guard');
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
      if (!isCurrent()) return suppressed('guard');
      const current = await options.storage.chats.get(scope);
      if (
        !current ||
        publicationDecision(route, current, outcome).kind !== decision.kind ||
        !isCurrent()
      )
        return suppressed('guard');
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
      if (!(await guard.allow())) return suppressed('guard');
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
        if (!budget || !meter || !isCurrent()) return false;
        if (started) {
          if (route.kind === 'initiative') budget.repeatInitiative?.(meter);
          return !flood || budget.currentFlood(meter);
        }
        const admission = budget.start(meter, isCurrent);
        if (!admission.allowed) {
          denial.reason = admission.reason;
          return false;
        }
        permit = admission.permit;
        started = true;
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
      const confirmPart = (part: PublishedPart): void => {
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
          }
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
            ...(meter ? { beforeSend } : {}),
            confirmPart,
          }),
        );
        if (result?.kind === 'delivered' && 'receipt' in result) {
          if (parts.size === 0) confirmPart({ ...result.receipt, text, ...replyFields });
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
  return Object.freeze({
    stats() {
      return Object.freeze({ ...counters });
    },
    async onSettled(work: QueueSettlement, completion: QueueCompletion) {
      await publish(
        work,
        completion.preparationFailure
          ? { kind: completion.preparationFailure }
          : (completion.result ?? { kind: completion.outcome }),
        { authorLabels: completion.authorLabels ?? [] },
      );
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
