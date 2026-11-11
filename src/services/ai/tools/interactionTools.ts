import config from '../../../config/index.js';
import { logger } from '../../../logger/index.js';
import {
  gameActions,
  gameFamilies,
  type GameAction,
  type GameFamily,
  type GameInteractionRequest,
} from '../../games/gameInteractionService.js';
import type { AITool } from '../AIProvider.js';

export type InteractionOutcome = {
  status: 'info' | 'result' | 'not_executed' | 'uncertain';
  message: string;
};

type BoundToolContext = {
  senderId: string;
  execute: () => Promise<InteractionOutcome>;
};

/**
 * Позволяет модели решить, стоит ли отвечать на неадресованное сообщение в активном режиме.
 */
export function createActiveChatDecisionTool(context: {
  senderId: string;
  decide: (respond: boolean) => InteractionOutcome;
}): AITool {
  let decided = false;
  return {
    name: 'decide_chat_response',
    description:
      'Сначала реши, отвечать ли на неадресованное сообщение в активном режиме. Выбирай true для открытого вопроса или просьбы, false для обычной переписки и обращения к другому человеку.',
    parameters: {
      type: 'object',
      properties: { respond: { type: 'boolean' } },
      required: ['respond'],
      additionalProperties: false,
    },
    async execute(input) {
      if (
        typeof input !== 'object' ||
        input === null ||
        Array.isArray(input) ||
        Object.keys(input).some((key) => key !== 'respond') ||
        !('respond' in input) ||
        typeof input.respond !== 'boolean'
      ) {
        logger.warn({ senderId: context.senderId }, 'AI chat decision received invalid arguments');
        return JSON.stringify({
          status: 'not_executed',
          message: 'Укажите respond: true или false.',
        });
      }
      if (decided) {
        return JSON.stringify({ status: 'not_executed', message: 'Решение уже принято.' });
      }
      decided = true;
      return JSON.stringify(context.decide(input.respond));
    },
  };
}

function createBoundTool(name: string, description: string, context: BoundToolContext): AITool {
  let attempted = false;
  return {
    name,
    description,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(input) {
      if (
        typeof input !== 'object' ||
        input === null ||
        Array.isArray(input) ||
        Object.keys(input).length > 0
      ) {
        logger.warn(
          { senderId: context.senderId, tool: name },
          'AI tool received invalid arguments',
        );
        return JSON.stringify({
          status: 'not_executed',
          message: 'Инструмент не принимает аргументы.',
        });
      }
      if (attempted) {
        return JSON.stringify({ status: 'not_executed', message: 'Это действие уже запрошено.' });
      }
      attempted = true;
      return JSON.stringify(await context.execute());
    },
  };
}

/**
 * Сохраняет заполненную анкету реального автора текущего сообщения в текущей беседе.
 */
export function createQuestionnaireTool(context: BoundToolContext): AITool {
  return createBoundTool(
    'save_questionnaire',
    'Сохранить заполненный шаблон анкеты из текущего сообщения автора. Не передавай ответы, ID или другую беседу.',
    context,
  );
}

/**
 * Передаёт запрос или уточнение автора существующему сервису напоминаний.
 */
export function createReminderTool(context: BoundToolContext): AITool {
  return createBoundTool(
    'manage_reminder',
    'Создать, изменить, показать или отменить напоминание либо ответить на уточнение по нему. Используется текст текущего сообщения.',
    context,
  );
}

/**
 * Выполняет запрос автора к личной или общей долговременной памяти с проверкой доступа.
 */
export function createMemoryTool(context: BoundToolContext): AITool {
  return createBoundTool(
    'manage_memory',
    'Управлять долговременной памятью по явной просьбе автора или ответить на уточнение. Личные данные отправляются только владельцу.',
    context,
  );
}

/**
 * Обрабатывает запрос автора к текущей игре, мафии, приключению или баттлу.
 */
export function createGameTool(context: {
  senderId: string;
  execute: (request: GameInteractionRequest) => Promise<InteractionOutcome>;
}): AITool {
  let attempted = false;
  return {
    name: 'play_game',
    description:
      'Начать игру или выполнить действие автора в обычной игре, мафии, приключении или баттле. Используй inspect, если текущая игра неясна; start — начать, answer — ответ или свободный ход, command — действие в формате игры.',
    parameters: {
      type: 'object',
      properties: {
        game: {
          type: 'string',
          enum: gameFamilies,
          description:
            'current — текущая игра, standard — обычная игра, mafia, adventure или battle.',
        },
        action: { type: 'string', enum: gameActions },
        value: {
          type: 'string',
          description:
            'Для start: ID обычной игры (quiz, riddle, character, word, truth, who, songfilm, association, story) и настройки; для adventure — жанр; для battle — число раундов 1–5. Иначе ответ, цель, сложность 1–4 или действие; если не нужно — пустая строка.',
        },
      },
      required: ['game', 'action', 'value'],
      additionalProperties: false,
    },
    async execute(input) {
      if (
        typeof input !== 'object' ||
        input === null ||
        Array.isArray(input) ||
        Object.keys(input).some((key) => key !== 'game' && key !== 'action' && key !== 'value') ||
        !('game' in input) ||
        typeof input.game !== 'string' ||
        !gameFamilies.some((game) => game === input.game) ||
        !('action' in input) ||
        typeof input.action !== 'string' ||
        !gameActions.some((action) => action === input.action) ||
        !('value' in input) ||
        typeof input.value !== 'string' ||
        input.value.length > config.MAX_INPUT_CHARS
      ) {
        logger.warn({ senderId: context.senderId }, 'AI game tool received invalid arguments');
        return JSON.stringify({
          status: 'not_executed',
          message: 'Укажите игру, действие и текст хода.',
        });
      }
      const game = gameFamilies.find((item): item is GameFamily => item === input.game);
      const action = gameActions.find((item): item is GameAction => item === input.action);
      if (!game || !action) {
        throw new Error('Validated game action is unavailable');
      }
      if (action !== 'inspect') {
        if (attempted) {
          return JSON.stringify({
            status: 'not_executed',
            message: 'Игровое действие уже запрошено.',
          });
        }
        attempted = true;
      }
      return JSON.stringify(await context.execute({ game, action, value: input.value }));
    },
  };
}
