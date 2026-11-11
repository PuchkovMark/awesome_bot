import { gameModes } from '../../games/gameEngine.js';
import type { AITool } from '../AIProvider.js';
import { buildBotCapabilities, type CapabilityContext } from '../capabilityService.js';

type CommandToolContext = CapabilityContext & { commandReference: string };

/**
 * Инструмент get_bot_commands выдаёт модели справку о командах, возможностях
 * и ограничениях текущего диалога. Не принимает аргументы и не выполняет команды.
 */
export function createBotCommandsTool(getContext: () => Promise<CommandToolContext>): AITool {
  return {
    name: 'get_bot_commands',
    description:
      'Получить актуальную справку о командах и возможностях бота, их синтаксисе, настройках и ограничениях доступа. Инструмент не выполняет команды.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(args) {
      if (
        typeof args !== 'object' ||
        args === null ||
        Array.isArray(args) ||
        Object.keys(args).length > 0
      ) {
        throw new Error('get_bot_commands does not accept arguments');
      }
      const context = await getContext();
      return [
        buildBotCapabilities(context),
        `Запуск игры: /games <id>. Доступные игры: ${Object.values(gameModes)
          .map(({ id, title }) => `${id} (${title})`)
          .join('; ')}.`,
        context.commandReference,
      ].join('\n\n');
    },
  };
}
