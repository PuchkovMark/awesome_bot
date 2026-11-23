import type { ConnectionScope } from '../contracts/index';
import type { MessageInput, StoredMessage } from './types';
import type { InitiativeCause } from '../core/message-router/autonomous-rules';
export type InitiativeDenial =
  | 'initiative_mode'
  | 'initiative_pause'
  | 'initiative_quiet_hours'
  | 'initiative_other_bot'
  | 'initiative_sensitive'
  | 'initiative_answered'
  | 'initiative_source'
  | 'initiative_flood'
  | 'initiative_quota'
  | 'initiative_rate'
  | 'initiative_expired';
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
export type QueueOutcome =
  | 'completed'
  | 'failed'
  | 'rate_limit'
  | 'interrupted'
  | 'expired'
  | 'message_missing'
  | 'deadline_exceeded';
export type QueueAdmission =
  | { readonly status: 'queued'; readonly messageId: number; readonly jobId: number }
  | { readonly status: 'not_needed' | 'duplicate' | 'queue_full'; readonly messageId: number }
  | { readonly status: 'stopped' | 'history_unavailable' };
export interface QueueRoutingSnapshot {
  readonly message: StoredMessage;
  readonly receivedAt: number;
}
/** Доверенная чистая функция: без I/O, случайности, часов и изменения состояния. */
export type QueueDecision = (input: QueueRoutingSnapshot) => boolean;
export interface QueueRecord {
  readonly id: number;
  readonly messageId: number;
  readonly receivedAt: number;
  readonly expiresAt: number;
  readonly state: 'queued' | 'running' | 'terminal';
  readonly outcome: QueueOutcome | null;
}
export interface QueueStore {
  get(scope: ConnectionScope, id: number): Promise<QueueRecord | null>;
}
export interface QueueStats {
  readonly depthQueued: number;
  readonly depthRunning: number;
  readonly waitCount: number;
  readonly waitTotalMs: number;
  readonly waitMaxMs: number;
  readonly rejected: number;
  readonly expired: number;
  readonly interrupted: number;
}
export interface QueueWork {
  readonly id: number;
  readonly scope: ConnectionScope;
  readonly messageId: number;
  readonly receivedAt: number;
  readonly route: RouteMetadata | null;
  readonly disclosureVersion?: number;
  readonly controlRevision?: number;
  readonly initiativeEvidenceId?: number;
  readonly expiresAt?: number;
}
export type QueueMessage = MessageInput;

export interface DirectRoute {
  readonly kind: 'direct_message' | 'mention' | 'reply' | 'name';
  readonly mode: 'normal' | 'active';
  readonly isGroupChat: boolean;
}
export type RouteMetadata =
  | DirectRoute
  | {
      readonly kind: 'initiative';
      readonly mode: 'active';
      readonly isGroupChat: true;
      readonly cause: InitiativeCause;
    };

export interface RoutedQueueDecision {
  readonly privateCommand?: true;
  readonly skipQuestionnaire?: true;
  readonly initiative?: InitiativeCause;
  readonly route: DirectRoute | null;
  readonly reason:
    | 'direct_message'
    | 'mention'
    | 'reply'
    | 'name'
    | 'service'
    | 'disabled'
    | 'silent'
    | 'sender_bot'
    | 'sender_unknown'
    | 'invalid_input'
    | 'not_addressed'
    | 'forbidden'
    | 'reply_unknown'
    | 'reply_other'
    | 'mention_flood';
}
export type RoutedQueueCallback = (
  input: QueueRoutingSnapshot & { readonly settings: import('./types').ChatSettings },
) => RoutedQueueDecision;
export interface FloodNotice {
  readonly messageId: number;
  readonly receivedAt: number;
  readonly controlRevision: number;
  readonly disclosureVersion: number | null;
  readonly route: RouteMetadata;
}
export interface RoutedAdmission {
  readonly admission: QueueAdmission | { readonly status: 'paused' };
  readonly decision: RoutedQueueDecision | null;
  readonly floodNotice?: FloodNotice;
}
export interface ResponsePublication {
  readonly scope: ConnectionScope;
  readonly key: string;
  readonly messageId: number;
  readonly route: RouteMetadata;
  readonly notice?: {
    readonly kind: import('./notice-types').RateLimitedNotice;
    readonly interval: number;
  };
  readonly flood?: FloodNotice;
}
export type ResponsePublicationAdmission =
  | { readonly allowed: true; readonly permit?: import('./notice-types').NoticePermit }
  | {
      readonly allowed: false;
      readonly reason: 'guard' | 'response_rate' | 'notice_period' | InitiativeDenial;
    };
export interface ResponsePublicationBudget {
  currentFlood(input: ResponsePublication): boolean;
  start(input: ResponsePublication, isCurrent: () => boolean): ResponsePublicationAdmission;
  repeatInitiative?(input: ResponsePublication): void;
  confirmInitiative?(
    input: ResponsePublication,
    receipt: import('./notice-types').NoticeReceipt,
    text: string,
    replyToMessageId: string | undefined,
    isCurrent: () => boolean,
  ): void;
  finish(
    input: ResponsePublication,
    outcome: import('./response-rate-store').ResponseRateOutcome,
  ): void;
}
export type RoutedAdmissionGuard = () => {
  readonly journal: boolean;
  readonly respond: boolean;
  readonly version: number | null;
  readonly ordinary?: boolean;
};
