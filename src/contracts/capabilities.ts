import type { ChatId, Timestamp, UserId } from './identifiers';

export type CapabilityName =
  'send' | 'typing' | 'reply' | 'getUserName' | 'adminInfo' | 'membershipEvents' | 'directMessage';
export type CapabilityState = 'supported' | 'unsupported' | 'unknown';
export type TextFormat = 'plain' | 'markdown' | 'html';
export type MessageLengthLimit =
  | {
      readonly value: number;
      readonly unit: 'utf16' | 'unicodeCodePoints' | 'utf8Bytes';
    }
  | 'unknown';

export interface CapabilityContext {
  readonly chatId: ChatId;
  /** Возможность directMessage относится к этому пользователю. */
  readonly userId?: UserId;
}

/** Снимок наблюдений, а не разрешение на действие или обещание свежести. */
export interface CapabilitySnapshot {
  readonly context: CapabilityContext;
  readonly observedAt: Timestamp;
  readonly support: Readonly<Record<CapabilityName, CapabilityState>>;
  readonly maxMessageLength: MessageLengthLimit;
  readonly textFormats: readonly TextFormat[];
}
