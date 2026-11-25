import type { ChatId, PlatformMessageId, Timestamp, UserId } from './identifiers';

export type KnownBoolean = boolean | 'unknown';
export type NeutralText = string;

/** Непрозрачная ссылка адаптера; без raw payload, токенов или обработки медиа. */
export interface Attachment {
  readonly kind: string;
  readonly reference?: string;
}

export interface IncomingMessage {
  readonly kind: 'message';
  readonly chatId: ChatId;
  readonly userId: UserId;
  readonly authorName: string;
  readonly isGroupChat: boolean;
  readonly isAdmin: KnownBoolean;
  readonly isBot: KnownBoolean;
  readonly text: NeutralText;
  /** Исходный текст для служебной обработки, если адаптер снял адресацию. */
  readonly literalText?: NeutralText;
  readonly messageId: PlatformMessageId;
  readonly replyToMessageId?: PlatformMessageId;
  /** Автор проверенного сообщения, на которое пришёл прямой ответ. */
  readonly replyAuthorId?: UserId;
  /** Непроверенная ссылка позволяет отклонить действие, но не подтверждает ответ. */
  readonly unverifiedReplyToMessageId?: PlatformMessageId;
  readonly isReplyToBot: boolean;
  readonly replyAddress?: 'bot' | 'other' | 'unknown';
  /** Подсказка для выбора служебного маршрута. Сама по себе не подтверждает reply. */
  readonly botReplyText?: NeutralText;
  readonly soleBotMention?: boolean;
  readonly hasOtherAddress?: boolean;
  readonly hasForwarded?: boolean;
  readonly isMentioned: boolean;
  readonly timestamp: Timestamp;
  readonly attachments: readonly Attachment[];
}

export type MembershipChange = 'joined' | 'invited' | 'left' | 'removed' | 'unknown';

export interface MembershipEvent {
  readonly kind: 'membership';
  readonly chatId: ChatId;
  readonly timestamp: Timestamp;
  readonly eventId?: string;
  readonly subjectId: UserId | null;
  readonly actorId: UserId | null;
  readonly change: MembershipChange;
}

export type IncomingEvent = IncomingMessage | MembershipEvent;

export interface OutgoingMessage {
  readonly chatId: ChatId;
  readonly text: NeutralText;
  readonly replyToMessageId?: PlatformMessageId;
}
