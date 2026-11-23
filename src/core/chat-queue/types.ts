import type {
  RoutedQueueCallback,
  RoutedAdmission,
  RoutedAdmissionGuard,
} from '../../storage/queue-types';
import type { ConnectionScope } from '../../contracts/index';
import type { SafeLogger } from '../../logger/types';
import type { Storage, MessageInput } from '../../storage/index';
import type {
  QueueAdmission,
  QueueConfig,
  QueueDecision,
  QueueOutcome,
  QueueStats,
} from '../../storage/queue-types';
import type { ChatLimits } from '../chat-limits/config';
import type { AttemptAdmission } from '../agent-loop/types';
export type {
  QueueAdmission,
  QueueConfig,
  QueueDecision,
  QueueOutcome,
  QueueStats,
} from '../../storage/queue-types';
export interface QueueHandlerInput {
  readonly jobId: number;
  readonly recordTrace: (
    update: Partial<
      Pick<
        import('../../storage/trace-types').TracePayload,
        | 'model'
        | 'prompt'
        | 'context'
        | 'summary'
        | 'preparationFailure'
        | 'resultKind'
        | 'disclosure'
      >
    >,
  ) => void;
  readonly scope: ConnectionScope;
  readonly messageId: number;
  readonly signal: AbortSignal;
  readonly route: import('../../storage/queue-types').RouteMetadata | null;
  readonly isCurrent: () => boolean;
  readonly disclosureVersion?: number;
  readonly admitModelAttempt?: (
    allow: () => boolean,
    contextIds?: readonly number[],
  ) => AttemptAdmission;
}
export type QueueHandler = (input: QueueHandlerInput) => Promise<QueueOutcome | QueueCompletion>;
export interface QueueCompletion {
  readonly outcome: QueueOutcome;
  readonly preparationFailure?: import('../context/types').PreparationFailure;
  readonly result?: import('../agent-loop/types').AgentLoopResult;
}
export interface QueueSettlement extends Omit<
  QueueHandlerInput,
  'recordTrace' | 'jobId' | 'admitModelAttempt'
> {
  readonly jobId?: number;
  readonly route: import('../../storage/queue-types').RouteMetadata | null;
  readonly isCurrent: () => boolean;
}
export interface ChatQueueOptions {
  readonly tracing: Pick<import('../response-tracing/config').TraceConfig, 'messageRetentionDays'> &
    Partial<import('../response-tracing/config').TraceConfig>;
  readonly onSettled?: (work: QueueSettlement, completion: QueueCompletion) => Promise<void>;
  readonly storage: Storage;
  readonly handler: QueueHandler;
  readonly config?: Partial<QueueConfig>;
  readonly logger?: SafeLogger;
  readonly limits?: Partial<ChatLimits>;
  readonly responseRate?: import('../chat-limits/response-rate-config').ResponseRateConfig;
  /** У привязанного к платформе воркера проверка непрерывности предшествует выдаче работы. */
  readonly platform?: string;
}
export interface ChatQueue {
  readonly signal: AbortSignal;
  isRunning(): boolean;
  readonly responseBudget?: import('../../storage/queue-types').ResponsePublicationBudget;
  wakeHistoryMaintenance?(): void;
  start(): Promise<void>;
  admit(
    scope: ConnectionScope,
    message: MessageInput,
    decision: QueueDecision,
  ): Promise<QueueAdmission>;
  admitRouted(
    scope: ConnectionScope,
    message: MessageInput,
    decision: RoutedQueueCallback,
    guard?: RoutedAdmissionGuard,
  ): Promise<RoutedAdmission>;
  stop(): Promise<void>;
  traceStats(): Readonly<Record<import('../response-tracing/metrics').TraceEvent, number>>;
  stats(): QueueStats;
}
