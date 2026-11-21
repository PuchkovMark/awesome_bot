import type { AuthorizationContext, AuthorizationDecision, AuthorizationDenial, ChatId, GrantBasis, UserId } from '../../contracts/index.js';
import type { AppConfig } from '../../config/types.js';
import type { AuthorizationStore, AuthorizationTransaction } from '../../storage/index.js';
import { createContextAuthority } from './context.js';
import { botRole, evaluatePolicy } from './policy.js';
import { platformOf, validId, validTime } from './validation.js';

export type AuthorizationResult<T> = { readonly allowed: true; readonly value: T } | { readonly allowed: false; readonly code: AuthorizationDenial };
export interface AuthorizationOptions {
  readonly config: AppConfig['authorization'];
  readonly store: AuthorizationStore;
  readonly now?: () => number;
}
export const deny = (code: AuthorizationDenial): { readonly allowed: false; readonly code: AuthorizationDenial } => ({ allowed: false, code });

export function createAuthorizationService(options: AuthorizationOptions) {
  const config = Object.freeze({ ...options.config });
  if (!validId(config.ownerId) || !Number.isSafeInteger(config.reasonMaxLength) || config.reasonMaxLength <= 0
    || !Number.isSafeInteger(config.reasonRetentionDays) || config.reasonRetentionDays <= 0
    || !Number.isSafeInteger(config.reasonRetentionDays * 86_400_000)) throw new TypeError('Authorization: invalid_configuration');
  const authority = createContextAuthority(config.ownerId);
  const now = () => {
    const time = (options.now ?? Date.now)();
    if (!validTime(time)) throw new TypeError('Authorization: invalid_time');
    return time;
  };
  function policy(tx: AuthorizationTransaction, context: AuthorizationContext, action: unknown, subjectId?: UserId): AuthorizationDecision {
    const settings = tx.settings();
    if (!settings) return deny('not_found');
    return evaluatePolicy({ context, ownerId: config.ownerId, action, enabled: settings.enabled,
      bases: context.userId === config.ownerId ? [] : tx.bases(context.userId),
      revoked: context.userId === config.ownerId ? false : tx.isRevoked(context.userId),
      ...(subjectId === undefined ? {} : { subjectId }),
    });
  }
  async function guarded<T>(context: AuthorizationContext, action: unknown, subjectId: UserId | undefined,
    operation: (tx: AuthorizationTransaction) => AuthorizationResult<T>): Promise<AuthorizationResult<T>> {
    if (!authority.contains(context)) return deny('invalid_context');
    return options.store.transaction(context.chatId, tx => {
      const decision = policy(tx, context, action, subjectId);
      return decision.allowed ? operation(tx) : decision;
    });
  }
  return Object.freeze({
    /** Только подтверждённая приложением личность, не данные из текста/инструмента. */
    context: authority.create,
    confirmMembership: authority.confirmMembership,
    async check(context: AuthorizationContext, action: unknown, subjectId?: UserId): Promise<AuthorizationDecision> {
      return guarded(context, action, subjectId, () => ({ allowed: true, value: undefined }));
    },
    async role(context: AuthorizationContext) {
      if (!authority.contains(context)) return deny('invalid_context');
      return options.store.transaction(context.chatId, tx => ({ allowed: true as const, value: botRole(context.userId, config.ownerId,
        context.userId === config.ownerId ? [] : tx.bases(context.userId),
        context.userId === config.ownerId ? false : tx.isRevoked(context.userId)) }));
    },
    /** Системный вход подтверждённых исходных сведений; не метод инструмента. */
    async applyTrustedInitialAuthorities(chatId: ChatId, input: { readonly creatorId?: UserId | null; readonly inviterId?: UserId | null }): Promise<AuthorizationResult<'applied'>> {
      if (!validId(chatId)) return deny('wrong_scope');
      const entries: { userId: UserId; basis: GrantBasis }[] = [];
      for (const [basis, userId] of [['creator', input.creatorId], ['inviter', input.inviterId]] as const) {
        if (userId == null) continue;
        if (!validId(userId) || platformOf(userId) !== platformOf(chatId)) return deny('wrong_scope');
        entries.push({ userId, basis });
      }
      const time = now();
      return options.store.transaction(chatId, tx => {
        if (!tx.settings()) return deny('not_found');
        for (const entry of entries) {
          const holder = tx.holder(entry.basis);
          if (holder && holder !== entry.userId) return deny('conflict');
        }
        for (const entry of entries) {
          if (!tx.isRevoked(entry.userId)) tx.grant({ ...entry, grantedAt: time, grantedBy: null });
        }
        return { allowed: true, value: 'applied' };
      });
    },
    async grant(context: AuthorizationContext, userId: UserId, membership: unknown): Promise<AuthorizationResult<'granted' | 'existing'>> {
      return guarded(context, 'admin.grant', userId, tx => {
        if (tx.isRevoked(userId)) return deny('revoked');
        if (!authority.hasMembership(membership, context.chatId, userId)) return deny('unconfirmed_member');
        const existing = tx.bases(userId).includes('explicit');
        tx.grant({ userId, basis: 'explicit', grantedAt: now(), grantedBy: context.userId });
        return { allowed: true, value: existing ? 'existing' : 'granted' };
      });
    },
    async remove(context: AuthorizationContext, userId: UserId): Promise<AuthorizationResult<'removed'>> {
      return guarded(context, 'admin.remove', userId, tx => {
        if (tx.bases(userId).some(basis => basis !== 'explicit')) return deny('protected');
        tx.remove(userId, false); return { allowed: true, value: 'removed' };
      });
    },
  });
}
