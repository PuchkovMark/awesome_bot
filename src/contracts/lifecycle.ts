import type { ChatId, UserId } from './identifiers.js';
declare const scopeBrand: unique symbol;
/** Выдаётся доверенной границей; бренд не заменяет runtime-проверку. */
export interface ConnectionScope {
  readonly [scopeBrand]: true;
  readonly chatId: ChatId;
  readonly generation: number;
}
export interface LifecycleObservation {
  readonly confidence: 'confirmed' | 'uncertain' | 'unavailable';
  readonly bot: 'present' | 'absent' | 'unknown';
  readonly creatorId?: UserId | null;
  readonly inviterId?: UserId | null;
  readonly creatorChanged?: boolean;
  readonly members?: { readonly complete: boolean; readonly ids: readonly UserId[] };
}
/** Внедряется приложением; SDK-ответ не превращается в confirmed автоматически. */
export interface LifecycleSource {
  observe(request: { readonly chatId: ChatId }): Promise<LifecycleObservation>;
}
