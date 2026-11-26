import type { ConnectionScope, UserId } from '../contracts/index';
import type { RouteMetadata } from './queue-types';
export const noticeText = 'Сейчас не получилось ответить. Попробуйте позже.';
const templates = {
  generic: noticeText,
  current_message_too_large: 'Сообщение слишком большое для ответа. Попробуйте сократить его.',
  mention_flood: 'Слишком много обращений подряд. Попробуйте чуть позже.',
  quota_exhausted: 'Сейчас слишком много запросов. Попробуй чуть позже.',
  token_budget_exhausted: 'Бюджет токенов этой беседы исчерпан. Попробуйте позже.',
  rate_limit: noticeText,
  llm_wait_timeout: noticeText,
  llm_provider_paused: noticeText,
};
export type NoticeKind = keyof typeof templates;
export type RateLimitedNotice = 'quota_exhausted' | 'mention_flood' | 'token_budget_exhausted';

export function isLlmAvailabilityNotice(
  kind: unknown,
): kind is 'rate_limit' | 'llm_wait_timeout' | 'llm_provider_paused' {
  return kind === 'rate_limit' || kind === 'llm_wait_timeout' || kind === 'llm_provider_paused';
}

export function isRateLimitedNotice(kind: NoticeKind | undefined): kind is RateLimitedNotice {
  return (
    kind === 'quota_exhausted' || kind === 'mention_flood' || kind === 'token_budget_exhausted'
  );
}
export function noticeTemplate(kind: NoticeKind): string {
  return templates[kind];
}
declare const permitBrand: unique symbol;
export interface NoticePermit {
  readonly [permitBrand]: true;
}
export interface NoticeReceipt {
  readonly messageId: string;
  readonly userId: UserId;
  readonly authorName: string;
  readonly timestamp: number;
}
export interface NoticeBackend {
  readonly sourceVisible: (scope: ConnectionScope, id: number) => boolean;
  reserve(
    scope: ConnectionScope,
    messageId: number,
    route: RouteMetadata,
    interval: number,
    now: number,
    kind?: NoticeKind,
    queueFull?: true,
  ): NoticePermit | null;
  confirm(
    scope: ConnectionScope,
    permit: NoticePermit,
    receipt: NoticeReceipt,
    text?: string,
    isCurrent?: () => boolean,
  ): void;
  recordAnswer(
    scope: ConnectionScope,
    receipt: NoticeReceipt,
    text: string,
    replyToMessageId?: string,
    isCurrent?: () => boolean,
  ): void;
  retarget(permit: NoticePermit): void;
  discard(permit: NoticePermit): void;
}
