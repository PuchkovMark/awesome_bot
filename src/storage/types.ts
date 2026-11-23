import type { ScopedStorage } from './scoped-types';
import type { ChatId, UserId, PlatformMessageId, Timestamp } from '../contracts/index';

export interface MessageInput {
  readonly chatId: ChatId;
  readonly messageId: PlatformMessageId;
  readonly userId: UserId;
  readonly authorName: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly attachmentCount?: number | null;
  readonly isGroupChat?: boolean;
  readonly replyToMessageId?: PlatformMessageId;
  readonly timestamp: Timestamp;
}
export interface StoredMessage extends MessageInput {
  readonly id: number;
  readonly purpose: 'conversation' | 'service_notice';
}
export interface AppendResult {
  readonly status: 'inserted' | 'duplicate';
  readonly id: number;
}
export interface HistoryQuery {
  readonly limit: number;
  readonly from?: Timestamp;
  readonly to?: Timestamp;
}
export type ResponseMode = 'silent' | 'normal' | 'active';
export interface ChatInput {
  readonly responseMode: ResponseMode;
  readonly enabled: boolean;
  readonly createdAt: Timestamp;
  readonly title?: string | null;
  readonly timezone?: string;
}
export interface ChatSettings {
  readonly chatId: ChatId;
  readonly title: string | null;
  readonly responseMode: ResponseMode;
  readonly enabled: boolean;
  readonly timezone: string;
  readonly createdAt: Timestamp;
}
export interface ChatPatch {
  readonly title?: string | null;
  readonly responseMode?: ResponseMode;
  readonly enabled?: boolean;
  readonly timezone?: string;
}
export interface CreateChatResult {
  readonly status: 'created' | 'existing';
  readonly settings: ChatSettings;
}
export type MessageStore = ScopedStorage['messages'];
export type ChatStore = ScopedStorage['chats'];
export interface Storage extends ScopedStorage {
  close(): Promise<void>;
}
