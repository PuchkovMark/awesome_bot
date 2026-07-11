import memoryService from '../memory/memoryService';
import { logger } from '../../logger';

/**
 * CommandService — обрабатывает чат-команды.
 */
export class CommandService {
  /**
   * Обработать команду. Возвращает текст-ответа или null.
   */
  async handleCommand(command: string, args: string, peerId: string, senderId: string): Promise<string | null> {
    const cmd = command.toLowerCase();
    try {
      switch (cmd) {
        case 'help':
          return this.helpText();
        case 'ping':
          return 'pong';
        case 'reset': {
          const deleted = await memoryService.clearUserHistory(senderId, peerId);
          return `История в этом разговоре очищена (${deleted} сообщений).`;
        }
        case 'forget': {
          const deleted = await memoryService.clearUserHistory(senderId);
          return `Вся история пользователя удалена (${deleted} сообщений).`;
        }
        case 'system': {
          if (!args || args.trim().length === 0) return 'Укажите системное сообщение после /system.';
          await memoryService.addMessage({ conversationId: peerId, role: 'system', content: args });
          return 'Системное сообщение добавлено в контекст.';
        }
        default:
          return `Неизвестная команда: ${command}`;
      }
    } catch (err) {
      logger.error({ err, command, args, peerId, senderId }, 'Command handling failed');
      return 'Ошибка при выполнении команды.';
    }
  }

  private helpText(): string {
    return [
      '/help — показать эту справку',
      '/ping — проверить отклик',
      '/reset — очистить историю в текущем разговоре',
      '/forget — удалить всю вашу историю',
      '/system <text> — добавить системное сообщение в контекст',
    ].join('\n');
  }
}

const commandService = new CommandService();
export default commandService;
