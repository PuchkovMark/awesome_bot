import type { AuthorizationContext, ChatId, UserId } from '../../contracts/index';
import type { Storage } from '../../storage/index';
import { tokenBudgetStore, type TokenBudgetPatch } from '../../storage/token-budget-store';
import { deny, type createAuthorizationService } from '../authorization/service';

export function createTokenBudgetAdministration(options: {
  readonly storage: Storage;
  readonly authorization: Awaited<ReturnType<typeof createAuthorizationService>>;
  readonly isGroupChat: (chatId: ChatId) => boolean;
  readonly now?: () => number;
}) {
  const store = tokenBudgetStore(options.storage);
  const time = options.now ?? Date.now;

  return Object.freeze({
    async read(context: AuthorizationContext) {
      const decision = await options.authorization.check(context, 'usage.read');
      if (!decision.allowed) return decision;
      return {
        allowed: true,
        value: store.read(context.scope, options.isGroupChat(context.chatId), time()),
      } as const;
    },
    async update(context: AuthorizationContext, patch: TokenBudgetPatch, isCurrent: () => boolean) {
      const snapshot = { ...patch };
      const decision = await options.authorization.check(context, 'usage.configure');
      if (!decision.allowed) return decision;
      if (!isCurrent()) return deny('conflict');
      return {
        allowed: true,
        value: store.update(context.scope, options.isGroupChat(context.chatId), snapshot, time()),
      } as const;
    },
    /** Вход только из доверенного пути личных команд владельца. */
    overview(sender: UserId) {
      const decision = options.authorization.checkInstallationOwner(sender, 'usage.read');
      if (!decision.allowed) return decision;
      return { allowed: true, value: store.overview(options.isGroupChat, time()) } as const;
    },
  });
}
