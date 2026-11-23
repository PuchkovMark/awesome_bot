import type { ChatId, HumanMember, UserId, Timestamp, PlatformMessageId } from '../contracts/index';

/** Сохранённые платформенные сведения, не роль и не разрешение харнеса. */
export type ParticipantRole = HumanMember['role'];
export type ParticipantStatus = 'present' | 'left' | 'removed' | 'absent' | 'unknown';
export type FactSourceKind = 'self' | 'inferred' | 'admin';
/** Метка записи, не доказательство истинности и не приоритет источника. */
export type FactReliability = 'unknown' | 'unverified' | 'confirmed';
/** Намерение использования; не разрешает публикацию или доступ автоматически. */
export type FactVisibility = 'unknown' | 'bot' | 'chat';

export interface ParticipantRecord {
  readonly chatId: ChatId;
  readonly userId: UserId;
  readonly joinedAt: Timestamp | null;
  readonly role: ParticipantRole;
  readonly roleObservedAt: Timestamp | null;
  readonly status: ParticipantStatus;
  readonly statusObservedAt: Timestamp | null;
  /** Последнее известное сообщение в этом чате, не онлайн-статус или рейтинг. */
  readonly lastSeenAt: Timestamp | null;
}
export interface ParticipantProfileRecord {
  readonly chatId: ChatId;
  readonly userId: UserId;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}
export interface ProfileFactRecord extends ParticipantProfileRecord {
  readonly id: number;
  readonly fieldKey: string;
  readonly value: string;
  readonly sourceKind: FactSourceKind;
  readonly sourceUserId: UserId | null;
  readonly sourceMessageId: PlatformMessageId | null;
  readonly sourceNote: string | null;
  readonly reliability: FactReliability;
  readonly visibility: FactVisibility;
}

export type ProfileFactChange =
  | {
      readonly kind: 'set';
      readonly fieldKey: string;
      readonly value: string;
      readonly reliability: FactReliability;
      readonly sourceNote?: string;
    }
  | { readonly kind: 'withdraw'; readonly interest: string }
  | {
      readonly kind: 'visibility';
      readonly fieldKey: string;
      readonly interest?: string;
      readonly visibility: FactVisibility;
    };

export interface ProfileFactInput {
  readonly subjectId: UserId;
  readonly messageId: number;
  readonly change: ProfileFactChange;
}

export type ProfileFactWriteResult = 'recorded' | 'duplicate' | 'blocked';
