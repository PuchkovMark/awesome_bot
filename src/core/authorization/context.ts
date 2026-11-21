import type { AuthorizationContext, ChatId, UserId } from '../../contracts/index.js';
import { platformOf, validId } from './validation.js';

declare const membershipBrand: unique symbol;
export interface MembershipConfirmation { readonly [membershipBrand]: true }
export interface ConfirmedIdentity { readonly chatId: ChatId; readonly userId: UserId; readonly kind?: 'chat' | 'owner' }
/** Эти фабрики доступны доверенной входной границе приложения, никогда параметрам модели. */
export function createContextAuthority(ownerId: UserId) {
  const contexts = new WeakSet<object>();
  const memberships = new WeakMap<object, { chatId: ChatId; userId: UserId }>();
  return {
    create(input: ConfirmedIdentity): AuthorizationContext {
      if (!validId(input.chatId) || !validId(input.userId)
        || (input.kind !== undefined && input.kind !== 'chat' && input.kind !== 'owner')
        || (input.kind === 'owner' ? input.userId !== ownerId : platformOf(input.chatId) !== platformOf(input.userId))) {
        throw new TypeError('Authorization: invalid_context');
      }
      const context = Object.freeze({ chatId: input.chatId, userId: input.userId, kind: input.kind ?? 'chat', platform: platformOf(input.chatId) }) as unknown as AuthorizationContext;
      contexts.add(context); return context;
    },
    contains(value: unknown): value is AuthorizationContext {
      return typeof value === 'object' && value !== null && contexts.has(value);
    },
    confirmMembership(chatId: ChatId, userId: UserId): MembershipConfirmation {
      if (!validId(chatId) || !validId(userId) || platformOf(chatId) !== platformOf(userId)) throw new TypeError('Authorization: wrong_scope');
      const token = Object.freeze({}) as MembershipConfirmation;
      memberships.set(token, { chatId, userId }); return token;
    },
    hasMembership(token: unknown, chatId: ChatId, userId: UserId): boolean {
      if (!token || typeof token !== 'object') return false;
      const proof = memberships.get(token);
      return proof?.chatId === chatId && proof.userId === userId;
    },
  };
}
