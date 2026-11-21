import type { ScopedStorage } from './scoped-types.js';
import type { AuthorizationStore } from './authorization-types.js';
import type { ChatId, UserId, PlatformMessageId, Timestamp } from '../contracts/index.js';

export interface MessageInput {
  readonly chatId: ChatId;
  readonly messageId: PlatformMessageId;
  readonly userId: UserId;
  readonly authorName: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly replyToMessageId?: PlatformMessageId;
  readonly timestamp: Timestamp;
}
export interface StoredMessage extends MessageInput { readonly id: number }
export interface AppendResult { readonly status: 'inserted' | 'duplicate'; readonly id: number }
export interface HistoryQuery { readonly limit: number; readonly from?: Timestamp; readonly to?: Timestamp }
export type ResponseMode = 'always' | 'mention';
export interface ChatInput {
  readonly responseMode: ResponseMode;
  readonly enabled: boolean;
  readonly createdAt: Timestamp;
  readonly title?: string | null;
  readonly systemPrompt?: string | null;
  readonly timezone?: string;
}
export interface ChatSettings {
  readonly chatId: ChatId;
  readonly title: string | null;
  readonly systemPrompt: string | null;
  readonly responseMode: ResponseMode;
  readonly enabled: boolean;
  readonly timezone: string;
  readonly createdAt: Timestamp;
}
export interface ChatPatch {
  readonly title?: string | null;
  readonly systemPrompt?: string | null;
  readonly responseMode?: ResponseMode;
  readonly enabled?: boolean;
  readonly timezone?: string;
}
export interface CreateChatResult { readonly status: 'created' | 'existing'; readonly settings: ChatSettings }
export interface MessageStore {
  append(message: MessageInput): Promise<AppendResult>;
  list(chatId: ChatId, query: HistoryQuery): Promise<readonly StoredMessage[]>;
}
export interface ChatStore {
  get(chatId: ChatId): Promise<ChatSettings | null>;
  create(chatId: ChatId, input: ChatInput): Promise<CreateChatResult>;
  update(chatId: ChatId, patch: ChatPatch): Promise<ChatSettings | null>;
}
export interface Storage {
  readonly scoped: ScopedStorage;
  readonly authorization: AuthorizationStore;
  readonly messages: MessageStore;
  readonly chats: ChatStore;
  close(): Promise<void>;
}
