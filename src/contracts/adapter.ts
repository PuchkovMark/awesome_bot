import type { CapabilityContext, CapabilitySnapshot } from './capabilities';
import type { IncomingEvent, OutgoingMessage } from './events';
import type { ChatId, PlatformId, PlatformMessageId, Timestamp, UserId } from './identifiers';
import type { ConnectionScope } from './lifecycle';

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

export interface HumanMember {
  readonly userId: UserId;
  readonly role: 'member' | 'admin' | 'unknown';
}
export type HumanMembership =
  | { readonly complete: true; readonly people: number; readonly members: readonly HumanMember[] }
  | { readonly complete: false };

export interface ChannelAdapter {
  readonly platform: PlatformId;
  capabilities(context: CapabilityContext): Promise<CapabilitySnapshot>;
  start(handler: EventHandler): Promise<void>;
  send(message: OutgoingMessage): Promise<SendResult>;
  sendTyping(chatId: ChatId): Promise<void>;
  getUserName(userId: UserId): Promise<string | null>;
  humanMembership?(scope: ConnectionScope, signal: AbortSignal): Promise<HumanMembership>;
}
