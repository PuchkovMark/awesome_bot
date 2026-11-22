import type { RoutedQueueCallback, RoutedAdmission, RoutedAdmissionGuard } from '../../storage/queue-types.js';
import type { ConnectionScope } from '../../contracts/index.js';
import type { SafeLogger } from '../../logger/types.js';
import type { Storage, MessageInput } from '../../storage/index.js';
import type { QueueAdmission, QueueConfig, QueueDecision, QueueOutcome, QueueStats } from '../../storage/queue-types.js';
import type { ChatLimits } from '../chat-limits/config.js';
import type { AttemptAdmission } from '../agent-loop/types.js';
export type { QueueAdmission, QueueConfig, QueueDecision, QueueOutcome, QueueStats } from '../../storage/queue-types.js';
export interface QueueHandlerInput { readonly jobId:number;readonly recordTrace:(update:Partial<Pick<import('../../storage/trace-types.js').TracePayload,'model'|'prompt'|'context'|'summary'|'preparationFailure'|'resultKind'|'disclosure'>>)=>void; readonly scope: ConnectionScope; readonly messageId: number; readonly signal: AbortSignal; readonly route:import('../../storage/queue-types.js').RouteMetadata|null; readonly isCurrent:()=>boolean; readonly disclosureVersion?:number; readonly admitModelAttempt?:(allow:()=>boolean)=>AttemptAdmission }
export type QueueHandler = (input: QueueHandlerInput) => Promise<QueueOutcome|QueueCompletion>;
export interface QueueCompletion {readonly outcome:QueueOutcome;readonly preparationFailure?:import('../context/types.js').PreparationFailure;readonly result?:import('../agent-loop/types.js').AgentLoopResult}
export interface QueueSettlement extends Omit<QueueHandlerInput,'recordTrace'|'jobId'|'admitModelAttempt'> { readonly jobId?:number;readonly route:import('../../storage/queue-types.js').RouteMetadata|null;readonly isCurrent:()=>boolean}
export interface ChatQueueOptions {
  readonly tracing:Pick<import('../response-tracing/config.js').TraceConfig,'messageRetentionDays'>&Partial<import('../response-tracing/config.js').TraceConfig>;
  readonly onSettled?:(work:QueueSettlement,completion:QueueCompletion)=>Promise<void>;
  readonly storage: Storage; readonly handler: QueueHandler;
  readonly config?: Partial<QueueConfig>; readonly logger?: SafeLogger;
  readonly limits?: Partial<ChatLimits>;
  /** У привязанного к платформе воркера проверка непрерывности предшествует выдаче работы. */
  readonly platform?: string;
}
export interface ChatQueue {
  readonly signal:AbortSignal;
  isRunning():boolean;
  start(): Promise<void>;
  admit(scope: ConnectionScope, message: MessageInput, decision: QueueDecision): Promise<QueueAdmission>;
  admitRouted(scope:ConnectionScope,message:MessageInput,decision:RoutedQueueCallback,guard?:RoutedAdmissionGuard):Promise<RoutedAdmission>;
  stop(): Promise<void>;
  traceStats():Readonly<Record<import('../response-tracing/metrics.js').TraceEvent,number>>;
  stats(): QueueStats;
}
