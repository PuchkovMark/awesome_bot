import type { AuthorizationContext, ChatId } from '../../contracts/index.js';
import type { createAuthorizationService } from '../authorization/service.js';
import { historyClearStore } from '../../storage/history-retention-store.js';
import type { HistoryClearOrigin } from '../../storage/history-retention-store.js';
import type { Storage } from '../../storage/index.js';
import type { HistoryCommand } from './commands.js';

export function createHistoryClearService(options: {
  readonly storage: Storage;
  readonly authorization: Pick<Awaited<ReturnType<typeof createAuthorizationService>>, 'clearHistory'>;
  readonly wakeMaintenance: () => void;
  readonly now?: () => number;
}) {
  const store = historyClearStore(options.storage);
  const now = options.now ?? Date.now;
  return {
    privateTarget: store.privateTarget,
    async handle(context: AuthorizationContext, origin: ChatId, eventId: string, command: HistoryCommand,
      isCurrent: () => boolean, replayOnly = false): Promise<string | null> {
      const scope = context.scope;
      const source: HistoryClearOrigin = { initiator: context.userId, origin, owner: context.kind === 'owner' };
      const target = `${scope.chatId}@${scope.generation}`;
      if (command.kind === 'invalid' || (source.owner ? origin !== context.userId : origin !== scope.chatId)) return null;
      if (command.kind === 'request') {
        if (source.owner && (command.target?.chatId!==scope.chatId || command.target.generation!==scope.generation)) return null;
        const result = await options.authorization.clearHistory(context, isCurrent, () =>
          store.request(scope, source, eventId, now(), replayOnly));
        if (!result.allowed || !result.value) return null;
        const request = result.value;
        if (request.state === 'confirmed') return `Очистка истории ${target} уже подтверждена.`;
        if (request.state !== 'pending' || request.expiresAt <= now()) return 'Запрос очистки больше не действует. Начни заново.';
        return `Беседа ${target}. Сообщений к очистке: ${request.count}. Переписка в VK сохранится. `+
          `Команда подтверждения действует 5 минут с момента запроса: /подтвердить-очистку ${request.code}`;
      }
      if (replayOnly) return null;
      const result = await options.authorization.clearHistory(context, isCurrent, () => store.confirm(scope, source, command.code, now()));
      if (!result.allowed) return null;
      if (!result.value) return 'Код очистки недействителен или уже использован.';
      options.wakeMaintenance();
      return `Очистка истории ${target} подтверждена. Выбранные сообщения скрыты. Удаление локальных записей выполняется в фоне.`;
    },
  };
}
