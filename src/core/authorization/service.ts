import type {
  QuestionnaireReply,
  QuestionnaireReplyResult,
} from '../../storage/questionnaire-types';
import type { PassportReply, PassportReplyResult } from '../../storage/chat-passport-types';
import type {
  ProfileCommandEdit,
  ProfileCommandEditResult,
} from '../../storage/profile-command-types';
import type { ScopedAuthorizationTransaction, ScopedStorage } from '../../storage/scoped-types';
import { createReasonMaintenance } from './maintenance';
import type { AuthorizationScheduler } from './maintenance';
import type {
  AuthorizationContext,
  AuthorizationDecision,
  AuthorizationDenial,
  ConnectionScope,
  GrantBasis,
  UserId,
} from '../../contracts/index';
import type { AppConfig } from '../../config/types';
import type { AuthorizationTransaction, RevocationAudit } from '../../storage/index';
import type { ProfileFactInput, ProfileFactWriteResult } from '../../storage/participant-types';
import type { RecoveryOperation } from '../../storage/admin-recovery-store';
import { chatControlAction, type ChatControlCommand } from '../chat-control/commands';
import { applyChatControl, type ChatControlResult } from '../chat-control/service';
import { createContextAuthority } from './context';
import { botRole, evaluatePolicy } from './policy';
import { platformOf, validId, validTime } from './validation';

export type AuthorizationResult<T> =
  | { readonly allowed: true; readonly value: T }
  | { readonly allowed: false; readonly code: AuthorizationDenial; readonly maxLength?: number };
export interface AuthorizationOptions {
  readonly config: AppConfig['authorization'];
  readonly store: ScopedStorage['authorization'];
  readonly scheduler?: AuthorizationScheduler;
  readonly now?: () => number;
}
export const deny = (
  code: AuthorizationDenial,
): { readonly allowed: false; readonly code: AuthorizationDenial } => ({ allowed: false, code });

export async function createAuthorizationService(options: AuthorizationOptions) {
  const config = Object.freeze({ ...options.config });
  if (
    !validId(config.ownerId) ||
    !Number.isSafeInteger(config.reasonMaxLength) ||
    config.reasonMaxLength <= 0 ||
    !Number.isSafeInteger(config.reasonRetentionDays) ||
    config.reasonRetentionDays <= 0 ||
    !Number.isSafeInteger(config.reasonRetentionDays * 86_400_000)
  )
    throw new TypeError('Authorization: invalid_configuration');
  let disposed = false;
  const retentionMs = config.reasonRetentionDays * 86_400_000;
  const authority = createContextAuthority(config.ownerId);
  const now = () => {
    const time = (options.now ?? Date.now)();
    if (!validTime(time) || !Number.isSafeInteger(time + retentionMs))
      throw new TypeError('Authorization: invalid_time');
    return time;
  };
  function policy(
    tx: AuthorizationTransaction,
    context: AuthorizationContext,
    action: unknown,
    subjectId?: UserId,
    allowInitialOwnerSettings = false,
  ): AuthorizationDecision {
    const settings = tx.settings();
    if (
      !settings &&
      !(allowInitialOwnerSettings && context.kind === 'owner' && context.userId === config.ownerId)
    ) {
      return deny('not_found');
    }
    return evaluatePolicy({
      context,
      ownerId: config.ownerId,
      action,
      enabled: settings?.enabled ?? true,
      bases: context.userId === config.ownerId ? [] : tx.bases(context.userId),
      revoked: context.userId === config.ownerId ? false : tx.isRevoked(context.userId),
      ...(subjectId === undefined ? {} : { subjectId }),
    });
  }
  async function guarded<T>(
    context: AuthorizationContext,
    action: unknown,
    subjectId: UserId | undefined,
    operation: (tx: ScopedAuthorizationTransaction) => AuthorizationResult<T>,
    flags?: { readonly allowInitialOwnerSettings: boolean },
  ): Promise<AuthorizationResult<T>> {
    if (disposed || !authority.contains(context)) return deny('invalid_context');
    return options.store.transaction(context.scope, (tx) => {
      const decision = policy(tx, context, action, subjectId, flags?.allowInitialOwnerSettings);
      return decision.allowed ? operation(tx) : decision;
    });
  }
  const maintenance = createReasonMaintenance(options.store, retentionMs, now, options.scheduler);
  await maintenance.run();
  return Object.freeze({
    dispose() {
      disposed = true;
      maintenance.stop();
    },
    maintenanceStatus: maintenance.status,
    maintain: maintenance.run,
    /** Только подтверждённая приложением личность, не данные из текста/инструмента. */
    context: authority.create,
    async confirmMembership(scope: ConnectionScope, userId: UserId) {
      if (disposed) throw new TypeError('Authorization: invalid_context');
      return options.store.transaction(scope, (tx) =>
        authority.confirmMembership(scope, userId, tx.revision()),
      );
    },
    /** Доверенная граница личных команд удостоверяет отправителя установки. */
    checkInstallationOwner(userId: UserId, action: 'usage.read'): AuthorizationDecision {
      if (disposed) return deny('invalid_context');
      if (action !== 'usage.read') return deny('unknown_action');
      return userId === config.ownerId ? { allowed: true } : deny('forbidden');
    },
    async check(
      context: AuthorizationContext,
      action: unknown,
      subjectId?: UserId,
    ): Promise<AuthorizationDecision> {
      return guarded(context, action, subjectId, () => ({ allowed: true, value: undefined }), {
        allowInitialOwnerSettings: action === 'usage.read' || action === 'usage.configure',
      });
    },
    async applyQuestionnaireReply(
      context: AuthorizationContext,
      input: QuestionnaireReply,
      current: () => boolean,
    ) {
      if (disposed || !authority.contains(context)) return deny('invalid_context');
      if (context.kind !== 'chat') return deny('wrong_scope');
      return guarded<QuestionnaireReplyResult>(
        context,
        'chat.onboarding.configure',
        undefined,
        (tx) => {
          if (!tx.controlState().enabled || !current()) return deny('conflict');
          return { allowed: true, value: tx.applyQuestionnaireReply(context.userId, input, now()) };
        },
      );
    },
    async applyPassportReply(
      context: AuthorizationContext,
      input: PassportReply,
      current: () => boolean,
    ) {
      if (disposed || !authority.contains(context)) return deny('invalid_context');
      if (context.kind !== 'chat') return deny('wrong_scope');
      return guarded<PassportReplyResult>(context, 'chat.passport.edit', undefined, (tx) => {
        const state = tx.controlState();
        if (!state.enabled || !current()) return deny('conflict');
        return { allowed: true, value: tx.applyPassportReply(context.userId, input, now()) };
      });
    },
    async selectPersona(
      context: AuthorizationContext,
      personaId: string,
      messageId: number,
      current: () => boolean,
    ) {
      if (disposed || !authority.contains(context)) return deny('invalid_context');
      if (context.kind !== 'chat') return deny('wrong_scope');
      const direct = context.chatId === context.userId;
      return guarded<ReturnType<ScopedAuthorizationTransaction['selectStarterPersona']>>(
        context,
        direct ? 'persona.self.select' : 'chat.persona.select',
        direct ? context.userId : undefined,
        (tx) => {
          const state = tx.controlState();
          if (!state.enabled || (direct && state.mode === 'silent')) return deny('disabled');
          if (!current()) return deny('conflict');
          return {
            allowed: true,
            value: tx.selectStarterPersona(context.userId, personaId, messageId),
          };
        },
      );
    },
    async readOwnProfile(context: AuthorizationContext, subjectId: UserId) {
      return guarded(context, 'profile.self.manage', subjectId, (tx) => ({
        allowed: true,
        value: tx.readOwnProfile(context.userId, now()),
      }));
    },
    async editOwnProfile(
      context: AuthorizationContext,
      input: ProfileCommandEdit,
      current: () => boolean,
    ) {
      if (disposed || !authority.contains(context)) return deny('invalid_context');
      if (context.kind !== 'chat' || context.scope.chatId !== context.userId)
        return deny('wrong_scope');
      return guarded<ProfileCommandEditResult>(
        context,
        'profile.self.manage',
        context.userId,
        (tx) => {
          if (!current()) return deny('conflict');
          return { allowed: true, value: tx.editOwnProfile(context.userId, input, now()) };
        },
      );
    },
    async changeProfileFact(
      context: AuthorizationContext,
      input: ProfileFactInput,
    ): Promise<AuthorizationResult<ProfileFactWriteResult>> {
      if (disposed || !authority.contains(context)) return deny('invalid_context');
      if (context.kind !== 'chat') return deny('wrong_scope');
      if (!input || typeof input !== 'object') return deny('invalid_context');
      const snapshot = { ...input };
      const action =
        context.userId === snapshot.subjectId ? 'profile.self.manage' : 'profile.admin.add';
      return guarded(context, action, snapshot.subjectId, (tx) => ({
        allowed: true,
        value: tx.changeProfileFact(context.userId, snapshot),
      }));
    },
    async setTimezone(
      context: AuthorizationContext,
      value: string,
      isCurrent: () => boolean,
    ): Promise<AuthorizationDecision> {
      return guarded(context, 'chat.configure', undefined, (tx) => {
        if (!isCurrent()) return deny('conflict');
        tx.updateTimezone(value);
        return { allowed: true, value: undefined };
      });
    },
    async controlChat(
      context: AuthorizationContext,
      command: ChatControlCommand,
      isCurrent: () => boolean,
      messageId?: number,
    ): Promise<AuthorizationResult<ChatControlResult>> {
      return guarded<ChatControlResult>(
        context,
        chatControlAction(command).action,
        undefined,
        (tx) => {
          if (!isCurrent()) return deny('conflict');
          const state = tx.controlState();
          if ((!state.enabled || command.kind === 'on') && context.kind !== 'owner')
            return deny('disabled');
          if (
            command.kind !== 'settings' &&
            messageId !== undefined &&
            !tx.claimControlMessage(context.userId, messageId)
          ) {
            return { allowed: true, value: { status: 'duplicate', state } };
          }
          return {
            allowed: true,
            value: applyChatControl(
              tx,
              command,
              now(),
              context.kind === 'chat' ? messageId : undefined,
            ),
          };
        },
        { allowInitialOwnerSettings: true },
      );
    },
    async clearHistory<T>(
      context: AuthorizationContext,
      isCurrent: () => boolean,
      operation: () => T,
    ): Promise<AuthorizationResult<T>> {
      return guarded(context, 'chat.history.clear', undefined, () => {
        if (!isCurrent()) return deny('conflict');
        const value = operation();
        if (value instanceof Promise) {
          void value.catch(() => {});
          throw new TypeError('History clear: async operation');
        }
        return { allowed: true, value };
      });
    },
    async readDiagnostics<T>(
      context: AuthorizationContext,
      read: () => T,
    ): Promise<AuthorizationResult<T>> {
      return guarded(context, 'diagnostics.read', undefined, () => {
        const value = read();
        if (value instanceof Promise) {
          void value.catch(() => {});
          throw new TypeError('Diagnostics: async_reader');
        }
        return { allowed: true, value };
      });
    },
    async role(context: AuthorizationContext) {
      if (disposed || !authority.contains(context)) return deny('invalid_context');
      return options.store.transaction(context.scope, (tx) => ({
        allowed: true as const,
        value: botRole(
          context.userId,
          config.ownerId,
          context.userId === config.ownerId ? [] : tx.bases(context.userId),
          context.userId === config.ownerId ? false : tx.isRevoked(context.userId),
        ),
      }));
    },
    /** Системный вход подтверждённых исходных сведений; не метод инструмента. */
    async applyTrustedInitialAuthorities(
      scope: ConnectionScope,
      input: { readonly creatorId?: UserId | null; readonly inviterId?: UserId | null },
    ): Promise<AuthorizationResult<'applied'>> {
      if (disposed) return deny('invalid_context');
      const chatId = scope.chatId;
      if (!validId(chatId)) return deny('wrong_scope');
      const entries: { userId: UserId; basis: GrantBasis }[] = [];
      for (const [basis, userId] of [
        ['creator', input.creatorId],
        ['inviter', input.inviterId],
      ] as const) {
        if (userId == null) continue;
        if (!validId(userId) || platformOf(userId) !== platformOf(chatId))
          return deny('wrong_scope');
        entries.push({ userId, basis });
      }
      const time = now();
      return options.store.transaction(scope, (tx) => {
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
    async grant(
      context: AuthorizationContext,
      userId: UserId,
      membership: unknown,
    ): Promise<AuthorizationResult<'granted' | 'existing'>> {
      return guarded(context, 'admin.grant', userId, (tx) => {
        if (tx.isRevoked(userId)) return deny('revoked');
        if (!authority.hasMembership(membership, context.scope, userId, tx.revision()))
          return deny('unconfirmed_member');
        const existing = tx.bases(userId).includes('explicit');
        tx.grant({ userId, basis: 'explicit', grantedAt: now(), grantedBy: context.userId });
        return { allowed: true, value: existing ? 'existing' : 'granted' };
      });
    },
    async recoverAdmin(
      context: AuthorizationContext,
      userId: UserId,
      commandId: number,
      membership: unknown,
      isCurrent: () => boolean,
    ): Promise<
      AuthorizationResult<{ readonly operation: RecoveryOperation; readonly created: boolean }>
    > {
      return guarded<{ operation: RecoveryOperation; created: boolean }>(
        context,
        'admin.recover',
        userId,
        (tx) => {
          if (!isCurrent()) return deny('conflict');
          const previous = tx.recoveryCommand(context.userId, commandId);
          if (previous) {
            return previous.chatId === context.chatId &&
              previous.generation === context.scope.generation &&
              previous.userId === userId
              ? { allowed: true, value: { operation: previous, created: false } }
              : deny('conflict');
          }
          if (tx.isRevoked(userId)) return deny('revoked');
          if (!authority.hasMembership(membership, context.scope, userId, tx.revision()))
            return deny('unconfirmed_member');
          const result = tx.bases(userId).includes('explicit') ? 'existing' : 'granted';
          const at = now();
          tx.grant({ userId, basis: 'explicit', grantedAt: at, grantedBy: context.userId });
          return {
            allowed: true,
            value: {
              operation: tx.recordRecovery(
                { ownerId: context.userId, commandId, userId },
                result,
                at,
              ),
              created: true,
            },
          };
        },
      );
    },
    async revoke(
      context: AuthorizationContext,
      userId: UserId,
      reason: unknown,
    ): Promise<AuthorizationResult<'revoked' | 'existing'>> {
      const preliminary = await guarded(context, 'admin.revoke', userId, () => ({
        allowed: true,
        value: undefined,
      }));
      if (!preliminary.allowed) return preliminary;
      await maintenance.run();
      const time = now();
      const result = await guarded<'revoked' | 'existing'>(
        context,
        'admin.revoke',
        userId,
        (tx) => {
          if (typeof reason !== 'string' || !reason.trim()) return deny('invalid_reason');
          let length = 0;
          for (const character of reason) {
            void character;
            if (++length > config.reasonMaxLength)
              return { allowed: false, code: 'reason_too_long', maxLength: config.reasonMaxLength };
          }
          if (tx.isRevoked(userId)) return { allowed: true, value: 'existing' };
          const bases = tx.bases(userId);
          if (!bases.some((basis) => basis !== 'explicit')) return deny('conflict');
          tx.revoke({ userId, revokedBy: context.userId, revokedAt: time, bases, reason });
          return { allowed: true, value: 'revoked' };
        },
      );
      if (result.allowed && result.value === 'revoked') maintenance.notify(time);
      return result;
    },
    async restore(
      context: AuthorizationContext,
      userId: UserId,
    ): Promise<AuthorizationResult<'restored'>> {
      return guarded(context, 'admin.restore', userId, (tx) => {
        tx.restore(userId);
        return { allowed: true, value: 'restored' };
      });
    },
    async audit(
      context: AuthorizationContext,
      userId: UserId,
    ): Promise<AuthorizationResult<RevocationAudit | null>> {
      const preliminary = await guarded(context, 'admin.audit.read', userId, () => ({
        allowed: true,
        value: undefined,
      }));
      if (!preliminary.allowed) return preliminary;
      await maintenance.run();
      return guarded(context, 'admin.audit.read', userId, (tx) => {
        const audit = tx.audit(userId);
        return {
          allowed: true,
          value:
            audit && audit.revokedAt <= now() - retentionMs ? { ...audit, reason: null } : audit,
        };
      });
    },
    async remove(
      context: AuthorizationContext,
      userId: UserId,
    ): Promise<AuthorizationResult<'removed'>> {
      return guarded(context, 'admin.remove', userId, (tx) => {
        if (tx.bases(userId).some((basis) => basis !== 'explicit')) return deny('protected');
        tx.remove(userId, false);
        return { allowed: true, value: 'removed' };
      });
    },
  });
}
