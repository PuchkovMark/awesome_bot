import config from '../../../config/index.js';
import { logger } from '../../../logger/index.js';
import { commandAliases, normalizeCommandName } from '../../command/commandAliases.js';
import { isBotAdminCommand } from '../../command/commandService.js';
import settingsService from '../../settings/settingsService.js';
import type { AITool } from '../AIProvider.js';

type CommandExecutionContext = {
  senderId: string;
  executeCommand: (
    command: string,
    args: string,
    isAdmin: boolean,
  ) => Promise<{ status: 'result' | 'denied' | 'not_executed'; message: string }>;
  reportDenial: (message: string) => Promise<void>;
};

const availableCommands = new Set([
  ...Object.keys(commandAliases),
  'анкета',
  'удалить',
  'подтвердить',
]);

/**
 * Инструмент execute_bot_command выполняет одну команду от имени отправителя
 * текущего VK-сообщения. Проверяет аргументы и роль; обработчик команды дополнительно
 * проверяет её права. Возвращает модели результат или отказ.
 * Подтверждение рассылки и удаления собственного профиля остаётся за пользователем.
 */
export function createCommandExecutionTool(context: CommandExecutionContext): AITool {
  let commandAttempted = false;
  return {
    name: 'execute_bot_command',
    description:
      'Выполнить одну команду бота по явной просьбе автора текущего сообщения. Права проверяются приложением по реальному отправителю; нельзя передавать ID, роль или другую беседу. Результат отправляется пользователю напрямую.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Название одной русской или английской команды, без аргументов.',
        },
        arguments: {
          type: 'string',
          description: 'Аргументы команды одной строкой; пустая строка, если их нет.',
        },
      },
      required: ['command', 'arguments'],
      additionalProperties: false,
    },
    async execute(input) {
      if (
        typeof input !== 'object' ||
        input === null ||
        Array.isArray(input) ||
        Object.keys(input).some((key) => key !== 'command' && key !== 'arguments') ||
        !('command' in input) ||
        typeof input.command !== 'string' ||
        !('arguments' in input) ||
        typeof input.arguments !== 'string'
      ) {
        logger.warn({ senderId: context.senderId }, 'AI command tool received invalid arguments');
        return JSON.stringify({
          status: 'invalid',
          message: 'Команда не выполнена: нужны только строки command и arguments.',
        });
      }

      const rawCommand = input.command.trim().replace(/^[/!]/u, '');
      const command = normalizeCommandName(rawCommand);
      if (
        !/^[\p{L}\d]+$/u.test(rawCommand) ||
        !availableCommands.has(command) ||
        input.arguments.length > config.MAX_INPUT_CHARS
      ) {
        logger.warn({ senderId: context.senderId }, 'AI command tool received an invalid command');
        return JSON.stringify({
          status: 'invalid',
          message: 'Команда не выполнена: неизвестное имя или слишком длинные аргументы.',
        });
      }
      if (commandAttempted) {
        return JSON.stringify({
          status: 'not_executed',
          message: 'В одном ответе можно выполнить только одну команду.',
        });
      }
      commandAttempted = true;

      const deny = async (message: string) => {
        try {
          await context.reportDenial(message);
        } catch (error) {
          logger.warn(
            { err: error, senderId: context.senderId },
            'Unable to send an AI command denial to the user',
          );
        }
        return JSON.stringify({ status: 'denied', message });
      };

      let isAdmin: boolean;
      try {
        isAdmin = await settingsService.isAdmin(context.senderId);
      } catch (error) {
        logger.warn(
          { err: error, senderId: context.senderId },
          'Unable to verify the sender role for an AI command',
        );
        return deny('Доступ к команде не предоставлен: не удалось проверить ваши права.');
      }

      if (isBotAdminCommand(command) && !isAdmin) {
        return deny('Доступ к команде запрещён: она доступна только администраторам бота.');
      }
      if (command === 'подтвердить') {
        return deny('Подтвердите удаление самостоятельно командой /подтвердить удаление профиля.');
      }
      if (command === 'broadcast' && /^confirm(?:\s|$)/iu.test(input.arguments.trim())) {
        return deny('Подтвердите рассылку самостоятельно командой /рассылка confirm <текст>.');
      }

      return JSON.stringify(await context.executeCommand(command, input.arguments, isAdmin));
    },
  };
}
