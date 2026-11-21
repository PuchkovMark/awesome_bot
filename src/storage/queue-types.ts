import type { ConnectionScope } from '../contracts/index.js';
import type { MessageInput, StoredMessage } from './types.js';
export interface QueueConfig {
  readonly maxConcurrentChats: number;
  readonly maxQueuedPerChat: number;
  readonly maxQueuedTotal: number;
  readonly maxQueueAgeMs: number;
  readonly loopTimeoutMs: number;
  readonly handlerMarginMs: number;
  readonly handlerTimeoutMs: number;
  readonly leaseMs: number;
  readonly renewIntervalMs: number;
  readonly stopTimeoutMs: number;
}
export type QueueOutcome = 'completed' | 'failed' | 'rate_limit' | 'interrupted' | 'expired' | 'message_missing' | 'deadline_exceeded';
export type QueueAdmission =
  | { readonly status: 'queued'; readonly messageId: number; readonly jobId: number }
  | { readonly status: 'not_needed' | 'duplicate' | 'queue_full'; readonly messageId: number }
  | { readonly status: 'stopped' };
export interface QueueRoutingSnapshot { readonly message: StoredMessage; readonly receivedAt: number }
/** Доверенная чистая функция: без I/O, случайности, часов и изменения состояния. */
export type QueueDecision = (input: QueueRoutingSnapshot) => boolean;
export interface QueueRecord {
  readonly id: number; readonly messageId: number; readonly receivedAt: number; readonly expiresAt: number;
  readonly state: 'queued' | 'running' | 'terminal'; readonly outcome: QueueOutcome | null;
}
export interface QueueStore {
  get(scope: ConnectionScope, id: number): Promise<QueueRecord | null>;
}
export interface QueueStats {
  readonly depthQueued: number; readonly depthRunning: number;
  readonly waitCount: number; readonly waitTotalMs: number; readonly waitMaxMs: number;
  readonly rejected: number; readonly expired: number; readonly interrupted: number;
}
export interface QueueWork { readonly id: number; readonly scope: ConnectionScope; readonly messageId: number; readonly receivedAt: number; readonly route:RouteMetadata|null }
export type QueueMessage = MessageInput;

export interface RouteMetadata { readonly kind:'direct_message'|'mention'|'reply'|'name'; readonly mode:'normal'|'active'; readonly isGroupChat:boolean }

export interface RoutedQueueDecision { readonly route:RouteMetadata|null; readonly reason:'direct_message'|'mention'|'reply'|'name'|'service'|'disabled'|'silent'|'sender_bot'|'sender_unknown'|'invalid_input'|'not_addressed'|'forbidden' }
export type RoutedQueueCallback=(input:QueueRoutingSnapshot & {readonly settings:import('./types.js').ChatSettings})=>RoutedQueueDecision;
export interface RoutedAdmission {readonly admission:QueueAdmission;readonly decision:RoutedQueueDecision|null}
