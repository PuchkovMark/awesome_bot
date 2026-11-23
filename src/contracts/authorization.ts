import type { ConnectionScope } from './lifecycle';
import type { ChatId, PlatformId, UserId } from './identifiers';

export type BotRole = 'member' | 'admin' | 'owner';
export type GrantBasis = 'creator' | 'inviter' | 'explicit';
export type AuthorizationAction =
  | 'chat.configure'
  | 'chat.history.clear'
  | 'chat.passport.edit'
  | 'chat.persona.select'
  | 'chat.onboarding.configure'
  | 'chat.pause'
  | 'chat.pause.extend'
  | 'reminder.manage'
  | 'admin.grant'
  | 'admin.remove'
  | 'admin.revoke'
  | 'admin.restore'
  | 'admin.recover'
  | 'admin.audit.read'
  | 'diagnostics.read'
  | 'usage.read'
  | 'usage.configure'
  | 'consent.edit'
  | 'profile.admin.add'
  | 'profile.self.manage'
  | 'persona.self.select'
  | 'onboarding.self.manage';
export type AuthorizationDenial =
  | 'invalid_context'
  | 'unknown_action'
  | 'forbidden'
  | 'wrong_scope'
  | 'disabled'
  | 'not_found'
  | 'protected'
  | 'revoked'
  | 'invalid_reason'
  | 'reason_too_long'
  | 'unconfirmed_member'
  | 'conflict';
export type AuthorizationDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly code: AuthorizationDenial };

declare const contextBrand: unique symbol;
/** Создаётся только доверенной границей; бренд сам по себе не доказывает происхождение. */
export interface AuthorizationContext {
  readonly [contextBrand]: true;
  readonly scope: ConnectionScope;
  readonly chatId: ChatId;
  readonly userId: UserId;
  readonly platform: PlatformId;
  readonly kind: 'chat' | 'owner';
}
