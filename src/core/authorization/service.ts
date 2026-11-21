import { createReasonMaintenance } from './maintenance.js';
import type { AuthorizationScheduler } from './maintenance.js';
import type { AuthorizationContext, AuthorizationDecision, AuthorizationDenial, ChatId, GrantBasis, UserId } from '../../contracts/index.js';
import type { AppConfig } from '../../config/types.js';
import type { AuthorizationStore, AuthorizationTransaction, RevocationAudit } from '../../storage/index.js';
import { createContextAuthority } from './context.js';
import { botRole, evaluatePolicy } from './policy.js';
import { platformOf, validId, validTime } from './validation.js';

export type AuthorizationResult<T> = { readonly allowed: true; readonly value: T } | { readonly allowed: false; readonly code: AuthorizationDenial };
export interface AuthorizationOptions {
  readonly config: AppConfig['authorization'];
  readonly store: AuthorizationStore;
  readonly scheduler?: AuthorizationScheduler;
  readonly now?: () => number;
}
export const deny = (code: AuthorizationDenial): { readonly allowed: false; readonly code: AuthorizationDenial } => ({ allowed: false, code });

export async function createAuthorizationService(options: AuthorizationOptions) {
  const config = Object.freeze({ ...options.config });
  if (!validId(config.ownerId) || !Number.isSafeInteger(config.reasonMaxLength) || config.reasonMaxLength <= 0
    || !Number.isSafeInteger(config.reasonRetentionDays) || config.reasonRetentionDays <= 0
    || !Number.isSafeInteger(config.reasonRetentionDays * 86_400_000)) throw new TypeError('Authorization: invalid_configuration');
  let disposed = false;
  const retentionMs = config.reasonRetentionDays * 86_400_000;
  const authority = createContextAuthority(config.ownerId);
  const now = () => {
    const time = (options.now ?? Date.now)();
    if (!validTime(time) || !Number.isSafeInteger(time + retentionMs)) throw new TypeError('Authorization: invalid_time');
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
    if (disposed || !authority.contains(context)) return deny('invalid_context');
    return options.store.transaction(context.chatId, tx => {
      const decision = policy(tx, context, action, subjectId);
      return decision.allowed ? operation(tx) : decision;
    });
  }
  const maintenance = createReasonMaintenance(options.store, retentionMs, now, options.scheduler);
  await maintenance.run();
  return Object.freeze({
    dispose() { disposed = true; maintenance.stop(); },
    maintenanceStatus: maintenance.status,
    maintain: maintenance.run,
    /** Только подтверждённая приложением личность, не данные из текста/инструмента. */
    context: authority.create,
    confirmMembership: authority.confirmMembership,
    async check(context: AuthorizationContext, action: unknown, subjectId?: UserId): Promise<AuthorizationDecision> {
      return guarded(context, action, subjectId, () => ({ allowed: true, value: undefined }));
    },
    async role(context: AuthorizationContext) {
      if (disposed || !authority.contains(context)) return deny('invalid_context');
      return options.store.transaction(context.chatId, tx => ({ allowed: true as const, value: botRole(context.userId, config.ownerId,
        context.userId === config.ownerId ? [] : tx.bases(context.userId),
        context.userId === config.ownerId ? false : tx.isRevoked(context.userId)) }));
    },
    /** Системный вход подтверждённых исходных сведений; не метод инструмента. */
    async applyTrustedInitialAuthorities(chatId: ChatId, input: { readonly creatorId?: UserId | null; readonly inviterId?: UserId | null }): Promise<AuthorizationResult<'applied'>> {
      if (disposed) return deny('invalid_context');
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
    async revoke(context: AuthorizationContext, userId: UserId, reason: unknown): Promise<AuthorizationResult<'revoked' | 'existing'>> {
      const preliminary = await guarded(context, 'admin.revoke', userId, () => ({ allowed: true, value: undefined }));
      if (!preliminary.allowed) return preliminary;
      await maintenance.run();
      const time = now();
      const result = await guarded<'revoked' | 'existing'>(context, 'admin.revoke', userId, tx => {
        if (typeof reason !== 'string' || !reason.trim()) return deny('invalid_reason');
        let length = 0;
        for (const character of reason) {
          void character;
          if (++length > config.reasonMaxLength) return deny('reason_too_long');
        }
        if (tx.isRevoked(userId)) return { allowed: true, value: 'existing' };
        const bases = tx.bases(userId);
        if (!bases.some(basis => basis !== 'explicit')) return deny('conflict');
        tx.revoke({ userId, revokedBy: context.userId, revokedAt: time, bases, reason });
        return { allowed: true, value: 'revoked' };
      });
      if (result.allowed && result.value === 'revoked') maintenance.notify(time);
      return result;
    },
    async restore(context: AuthorizationContext, userId: UserId): Promise<AuthorizationResult<'restored'>> {
      return guarded(context, 'admin.restore', userId, tx => {
        tx.restore(userId); return { allowed: true, value: 'restored' };
      });
    },
    async audit(context: AuthorizationContext, userId: UserId): Promise<AuthorizationResult<RevocationAudit | null>> {
      const preliminary = await guarded(context, 'admin.audit.read', userId, () => ({ allowed: true, value: undefined }));
      if (!preliminary.allowed) return preliminary;
      await maintenance.run();
      return guarded(context, 'admin.audit.read', userId, tx => {
        const audit = tx.audit(userId);
        return { allowed: true, value: audit && audit.revokedAt <= now() - retentionMs ? { ...audit, reason: null } : audit };
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
