import type { ChatId, UserId } from './identifiers';
declare const scopeBrand: unique symbol;
/** Выдаётся доверенной границей; бренд не заменяет runtime-проверку. */
export interface ConnectionScope {
  readonly [scopeBrand]: true;
  readonly chatId: ChatId;
  readonly generation: number;
}
export type ConnectionPauseReason =
  'startup' | 'observation_lost' | 'first_seen' | 'membership_signal' | 'verification_uncertain';
export interface ConnectionVersion {
  readonly chatId: ChatId;
  readonly generation: number;
  readonly revision: number;
}
export interface PausedConnection extends ConnectionVersion {
  readonly title: string | null;
  readonly reason: ConnectionPauseReason | null;
}
export interface RecoveryVersion extends ConnectionVersion {
  readonly controlRevision: number;
}
export interface LifecycleObservation {
  readonly confidence: 'confirmed' | 'uncertain' | 'unavailable';
  readonly bot: 'present' | 'absent' | 'unknown';
  readonly creatorId?: UserId | null;
  readonly inviterId?: UserId | null;
  readonly creatorChanged?: boolean;
  readonly departedIds?: readonly UserId[];
  readonly members?: { readonly complete: boolean; readonly ids: readonly UserId[] };
}
/** Внедряется приложением; SDK-ответ не превращается в confirmed автоматически. */
export interface LifecycleSource {
  observe(request: { readonly chatId: ChatId }): Promise<LifecycleObservation>;
}
