import type { RoutedQueueCallback, RoutedAdmission } from '../../storage/queue-types.js';
import type { ConnectionScope } from '../../contracts/index.js';
import type { SafeLogger } from '../../logger/types.js';
import type { Storage, MessageInput } from '../../storage/index.js';
import type { QueueAdmission, QueueConfig, QueueDecision, QueueOutcome, QueueStats } from '../../storage/queue-types.js';
export type { QueueAdmission, QueueConfig, QueueDecision, QueueOutcome, QueueStats } from '../../storage/queue-types.js';
export interface QueueHandlerInput { readonly scope: ConnectionScope; readonly messageId: number; readonly signal: AbortSignal }
export type QueueHandler = (input: QueueHandlerInput) => Promise<QueueOutcome>;
export interface ChatQueueOptions {
  readonly storage: Storage; readonly handler: QueueHandler;
  readonly config?: Partial<QueueConfig>; readonly logger?: SafeLogger;
}
export interface ChatQueue {
  start(): Promise<void>;
  admit(scope: ConnectionScope, message: MessageInput, decision: QueueDecision): Promise<QueueAdmission>;
  admitRouted(scope:ConnectionScope,message:MessageInput,decision:RoutedQueueCallback):Promise<RoutedAdmission>;
  stop(): Promise<void>;
  stats(): QueueStats;
}
