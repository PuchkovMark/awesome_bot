import type { AuthorizationContext, ConnectionScope, UserId } from '../../contracts/index';
import { platformOf, validId } from './validation';

declare const membershipBrand: unique symbol;
export interface MembershipConfirmation { readonly [membershipBrand]: true }
export interface ConfirmedIdentity { readonly scope: ConnectionScope; readonly userId: UserId; readonly kind?: 'chat' | 'owner' }
/** Эти фабрики доступны доверенной входной границе приложения, никогда параметрам модели. */
export function createContextAuthority(ownerId: UserId) {
  const contexts = new WeakSet<object>();
  const memberships = new WeakMap<object, { scope: ConnectionScope; userId: UserId; revision:number }>();
  return {
    create(input: ConfirmedIdentity): AuthorizationContext {
      if (!validId(input.scope?.chatId) || !validId(input.userId)
        || (input.kind !== undefined && input.kind !== 'chat' && input.kind !== 'owner')
        || (input.kind === 'owner' ? input.userId !== ownerId : platformOf(input.scope?.chatId) !== platformOf(input.userId))) {
        throw new TypeError('Authorization: invalid_context');
      }
      const context = Object.freeze({ scope:input.scope, chatId: input.scope?.chatId, userId: input.userId, kind: input.kind ?? 'chat', platform: platformOf(input.scope?.chatId) }) as unknown as AuthorizationContext;
      contexts.add(context); return context;
    },
    contains(value: unknown): value is AuthorizationContext {
      return typeof value === 'object' && value !== null && contexts.has(value);
    },
    confirmMembership(scope: ConnectionScope, userId: UserId, revision:number): MembershipConfirmation {
      const chatId=scope.chatId;
      if (!validId(chatId) || !validId(userId) || platformOf(chatId) !== platformOf(userId)) throw new TypeError('Authorization: wrong_scope');
      const token = Object.freeze({}) as MembershipConfirmation;
      memberships.set(token, { scope, userId, revision }); return token;
    },
    hasMembership(token: unknown, scope: ConnectionScope, userId: UserId, revision:number): boolean {
      if (!token || typeof token !== 'object') return false;
      const proof = memberships.get(token);
      return proof?.scope.chatId === scope.chatId && proof.scope.generation===scope.generation && proof.userId === userId && proof.revision===revision;
    },
  };
}
