import type { CapabilityContext, CapabilitySnapshot } from './capabilities.js';
import type { IncomingEvent, OutgoingMessage } from './events.js';
import type { ChatId, PlatformId, PlatformMessageId, Timestamp, UserId } from './identifiers.js';

export type EventHandler = (event: IncomingEvent) => Promise<void>;
/** Id отправленных частей в области чата. Ошибка отправки отклоняет Promise. */
export type SendResult = readonly [PlatformMessageId, ...PlatformMessageId[]];

export interface PublishedPart {
  readonly messageId: PlatformMessageId;
  readonly userId: UserId;
  readonly authorName: string;
  readonly text: string;
  readonly timestamp: Timestamp;
  readonly replyToMessageId?: PlatformMessageId;
}

export interface ChannelAdapter {
  readonly platform: PlatformId;
  capabilities(context: CapabilityContext): Promise<CapabilitySnapshot>;
  start(handler: EventHandler): Promise<void>;
  send(message: OutgoingMessage): Promise<SendResult>;
  sendTyping(chatId: ChatId): Promise<void>;
  getUserName(userId: UserId): Promise<string | null>;
}
