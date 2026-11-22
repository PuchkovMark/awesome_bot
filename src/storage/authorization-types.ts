import type { ChatId, UserId, GrantBasis, Timestamp } from '../contracts/index.js';
import type { RecoveryCommand, RecoveryOperation } from './admin-recovery-store.js';
import type { ChatControlState,ChatPause } from './chat-control-store.js';
import type { ChatPatch } from './types.js';

export interface AdminGrant {
  readonly userId: UserId;
  readonly basis: GrantBasis;
  readonly grantedAt: Timestamp;
  readonly grantedBy: UserId | null;
}
export interface RevocationAudit {
  readonly chatId: ChatId;
  readonly userId: UserId;
  readonly revokedBy: UserId;
  readonly revokedAt: Timestamp;
  readonly bases: readonly GrantBasis[];
  readonly reason: string | null;
}
/** Доверенная инфраструктура. Представление ограничено чатом и временем callback. */
export interface AuthorizationTransaction {
  revision(): number;
  settings(): { readonly enabled: boolean } | null;
  updateTimezone(value: string): void;
  controlState(): ChatControlState;
  updateControlSettings(patch: Pick<ChatPatch,'enabled'|'responseMode'>, createdAt: Timestamp): void;
  writePause(pause: ChatPause): void;
  claimControlMessage(actorId: UserId, messageId: number): boolean;
  holder(basis: GrantBasis): UserId | null;
  bases(userId: UserId): readonly GrantBasis[];
  isRevoked(userId: UserId): boolean;
  grant(grant: AdminGrant): void;
  remove(userId: UserId, all: boolean): void;
  revoke(audit: Omit<RevocationAudit, 'chatId'>): void;
  restore(userId: UserId): void;
  audit(userId: UserId): RevocationAudit | null;
  recoveryBlocked(): boolean;
  recoveryCommand(ownerId: UserId, commandId: number): RecoveryOperation | undefined;
  recordRecovery(input: RecoveryCommand, result: RecoveryOperation['result'], at: Timestamp): RecoveryOperation;
}
export type AuthorizationStore = import('./scoped-types.js').ScopedStorage['authorization'];
