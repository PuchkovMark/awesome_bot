import type { AuthorizationStore } from './legacy-authorization-types.js';
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
export type ResponseMode = 'silent' | 'normal' | 'active';
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
  readonly authorization: AuthorizationStore;
  readonly messages: MessageStore;
  readonly chats: ChatStore;
  close(): Promise<void>;
}
/** Только переход и внутренние SQL-компоненты; в index.ts не экспортируется. */
export type SyncStore<T> = { [K in keyof T]: T[K] extends (...args: infer A) => Promise<infer R> ? (...args: A) => R : never };
export type AsyncStore<T> = { [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never };
export function asyncStore<T extends object>(store:T):AsyncStore<T> {
  return Object.fromEntries(Object.entries(store).map(([key,value])=>[key,async (...args:unknown[])=> (value as (...args:unknown[])=>unknown)(...args)])) as AsyncStore<T>;
}
