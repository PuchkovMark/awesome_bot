import { Prisma } from '@prisma/client';
import { prisma } from '../../db/client.js';
import commandService from '../command/commandService.js';
import settingsService from '../settings/settingsService.js';
import adventureService, { adventureGenres, type AdventureResult } from './adventureService.js';
import { gameModes, parseGameKind } from './gameEngine.js';
import gameService from './gameService.js';
import mafiaService from './mafiaService.js';

export const gameFamilies = ['current', 'standard', 'mafia', 'adventure', 'battle'] as const;
export const gameActions = [
  'inspect',
  'start',
  'answer',
  'join',
  'leave',
  'hint',
  'repeat',
  'pause',
  'resume',
  'stop',
  'skip',
  'next',
  'score',
  'pass',
  'vote',
  'difficulty',
  'status',
  'command',
] as const;

export type GameFamily = (typeof gameFamilies)[number];
export type GameAction = (typeof gameActions)[number];
export type GameInteractionRequest = { game: GameFamily; action: GameAction; value: string };

export type GameInteractionContext = {
  conversationId: string;
  userId: string;
  isChat: boolean;
  isAdmin: boolean;
  canManageChat: boolean;
  displayName: string;
  eventId?: string;
  resolveUserDisplayName: (userId: string) => Promise<string | undefined>;
};

export type GameInteractionResult = {
  status: 'info' | 'result' | 'not_executed' | 'uncertain';
  message: string;
  adventureResult?: AdventureResult;
};

type ActiveGameFamily = Exclude<GameFamily, 'current'>;

function getGameFamily(game: string): ActiveGameFamily | undefined {
  if (game === 'mafia') return 'mafia';
  if (game === 'ai_adventure') return 'adventure';
  if (game === 'fun_battle') return 'battle';
  return Object.values(gameModes).some((mode) => mode.id === game) ? 'standard' : undefined;
}

function gameName(game: string): string {
  if (game === 'ai_adventure') return 'Приключение';
  if (game === 'fun_battle') return 'Юмористический баттл';
  return Object.values(gameModes).find((mode) => mode.id === game)?.title ?? game;
}

function textResult(message: string | null): GameInteractionResult {
  return message === null
    ? {
        status: 'uncertain',
        message:
          'Игра не вернула результат; действие могло быть учтено. Не повторяйте его автоматически.',
      }
    : { status: 'result', message };
}

function unsupportedAction(): GameInteractionResult {
  return { status: 'not_executed', message: 'Это действие не поддерживается текущей игрой.' };
}

/**
 * Передаёт действие текущей игры соответствующему игровому движку с правами отправителя.
 */
export class GameInteractionService {
  async handle(
    request: GameInteractionRequest,
    context: GameInteractionContext,
  ): Promise<GameInteractionResult> {
    const sessions = await prisma.gameSession.findMany({
      where: {
        conversationId: context.conversationId,
        game: { in: [...Object.keys(gameModes), 'ai_adventure', 'fun_battle'] },
        state: { in: ['waiting', 'active', 'paused', 'round_complete'] },
      },
      select: { id: true, game: true, state: true },
      orderBy: { updatedAt: 'desc' },
    });

    if (request.action === 'inspect') {
      const privateMafia =
        !context.isChat && (await mafiaService.hasPendingPrivateAction(context.userId));
      return {
        status: 'info',
        message: [
          sessions.length
            ? `Текущие игры: ${sessions.map(({ game, state }) => `${gameName(game)} (${state})`).join('; ')}.`
            : 'В этом диалоге нет активной игры.',
          privateMafia ? 'У вас есть доступный ночной ход мафии в личных сообщениях.' : '',
        ]
          .filter(Boolean)
          .join(' '),
      };
    }

    const value = request.value.trim();
    if (['answer', 'vote', 'command'].includes(request.action) && !value) {
      return { status: 'not_executed', message: 'Для этого действия нужен текст ответа или хода.' };
    }

    const options = {
      isGroup: context.isChat,
      isAdmin: context.isAdmin,
      canManageChat: context.canManageChat,
      eventId: context.eventId,
      name: context.displayName,
      isReplyToBot: true,
      allowNaturalStart: false,
      resolveUserDisplayName: context.resolveUserDisplayName,
    };

    const handleBattleCommand = async (command: string): Promise<GameInteractionResult> =>
      textResult(
        await commandService.handleCommand(
          'battle',
          command,
          context.conversationId,
          context.userId,
          context.isAdmin,
          context.canManageChat,
          settingsService.isCreator(context.userId),
          context.isChat,
          '',
          '',
          context.eventId ?? '',
          context.resolveUserDisplayName,
        ),
      );

    if (request.action === 'start') {
      if (request.game === 'current') {
        return { status: 'not_executed', message: 'Уточните, какую игру нужно начать.' };
      }
      if (request.game === 'standard') {
        const kind = parseGameKind(value.split(/\s+/u)[0] ?? '');
        if (!kind || kind === 'mafia') {
          return { status: 'not_executed', message: 'Укажите название обычной игры.' };
        }
        return textResult(
          await gameService.handleCommand(
            context.conversationId,
            context.userId,
            `start ${value}`,
            options,
          ),
        );
      }
      if (request.game === 'mafia') {
        return textResult(
          await mafiaService.handleCommand(
            context.conversationId,
            context.userId,
            `mafia start ${value}`.trim(),
            options,
          ),
        );
      }
      if (request.game === 'adventure') {
        const genre = value.toLocaleLowerCase('ru-RU') || 'random';
        if (genre !== 'random' && !adventureGenres.some((item) => item === genre)) {
          return { status: 'not_executed', message: 'Укажите допустимый жанр приключения.' };
        }
        const result = await adventureService.handleCommand(
          context.conversationId,
          context.userId,
          context.displayName,
          context.isChat,
          `start ${genre}`,
        );
        return { status: 'result', message: result.text, adventureResult: result };
      }
      return handleBattleCommand(`start ${value}`.trim());
    }

    if (
      !context.isChat &&
      (request.game === 'current' || request.game === 'mafia') &&
      ['answer', 'vote', 'command'].includes(request.action) &&
      (await mafiaService.shouldHandleMessage(
        context.conversationId,
        context.userId,
        value,
        options,
      ))
    ) {
      if (request.game === 'current' && sessions.length > 0) {
        return {
          status: 'not_executed',
          message:
            'Есть и личная игра, и доступный ночной ход мафии. Уточните, к какой игре относится действие.',
        };
      }
      return textResult(
        await mafiaService.handleNaturalMessage(
          context.conversationId,
          context.userId,
          value,
          options,
        ),
      );
    }

    const matching = sessions.filter(
      ({ game }) => request.game === 'current' || getGameFamily(game) === request.game,
    );
    if (matching.length === 0) {
      return { status: 'not_executed', message: 'Подходящей активной игры в этом диалоге нет.' };
    }
    if (matching.length > 1) {
      return {
        status: 'not_executed',
        message: `В этом диалоге несколько игр: ${matching.map(({ game }) => gameName(game)).join(', ')}. Уточните, к какой относится действие.`,
      };
    }

    const session = matching[0];
    const family = getGameFamily(session.game);
    if ((family === 'adventure' || family === 'battle') && context.eventId) {
      try {
        await prisma.gameEvent.create({
          data: {
            sessionId: session.id,
            vkUserId: context.userId,
            eventId: context.eventId,
            kind: `ai-${family}`,
          },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          return {
            status: 'not_executed',
            message: 'Это сообщение уже обрабатывалось. Проверьте состояние игры перед повтором.',
          };
        }
        throw error;
      }
    }
    if (family === 'standard') {
      if (request.action === 'answer' || request.action === 'vote') {
        return textResult(
          await gameService.handleNaturalMessage(
            context.conversationId,
            context.userId,
            value,
            options,
          ),
        );
      }
      if (request.action === 'command') {
        return textResult(
          await gameService.handleCommand(context.conversationId, context.userId, value, options),
        );
      }
      const actions: Partial<Record<GameAction, string>> = {
        join: 'присоединиться',
        hint: 'подсказка',
        repeat: 'повтори вопрос',
        pause: 'поставь игру на паузу',
        resume: 'продолжай игру',
        stop: 'заверши игру',
        skip: 'пропустить вопрос',
        next: 'следующий раунд',
        score: 'счёт',
        pass: 'передаю ход',
        status: 'счёт',
        difficulty: `измени сложность на ${value}`,
      };
      const action = actions[request.action];
      if (request.action === 'difficulty' && !/^[1-4]$/u.test(value)) {
        return { status: 'not_executed', message: 'Укажите сложность от 1 до 4.' };
      }
      return action
        ? textResult(
            await gameService.handleNaturalMessage(
              context.conversationId,
              context.userId,
              action,
              options,
            ),
          )
        : unsupportedAction();
    }

    if (family === 'mafia') {
      if (request.action === 'answer' || request.action === 'vote') {
        const action = request.action === 'vote' ? `голосую за ${value}` : value;
        return textResult(
          await mafiaService.handleNaturalMessage(
            context.conversationId,
            context.userId,
            action,
            options,
          ),
        );
      }
      const commands: Partial<Record<GameAction, string>> = {
        join: 'join',
        leave: 'leave',
        pause: 'pause',
        resume: 'resume',
        stop: 'stop',
        status: 'status',
        score: 'status',
        difficulty: `difficulty ${value}`.trim(),
        command: value,
      };
      const command = commands[request.action];
      return command
        ? textResult(
            await mafiaService.handleCommand(
              context.conversationId,
              context.userId,
              `mafia ${command}`,
              options,
            ),
          )
        : unsupportedAction();
    }

    if (family === 'adventure') {
      if (request.action === 'answer') {
        const result = await adventureService.submitAction(
          context.conversationId,
          context.userId,
          value,
          context.isChat,
        );
        return result
          ? { status: 'result', message: result.text, adventureResult: result }
          : { status: 'not_executed', message: 'Вы не участвуете в активном приключении.' };
      }
      const commands: Partial<Record<GameAction, string>> = {
        join: 'join',
        leave: 'leave',
        hint: 'hint',
        pause: 'pause',
        resume: 'resume',
        stop: 'end',
        status: 'status',
        vote: `vote ${value}`.trim(),
        difficulty: `settings сложность ${value}`.trim(),
        command: value,
      };
      const command = commands[request.action];
      if (!command) return unsupportedAction();
      const result = await adventureService.handleCommand(
        context.conversationId,
        context.userId,
        context.displayName,
        context.isChat,
        command,
      );
      return { status: 'result', message: result.text, adventureResult: result };
    }

    if (family === 'battle') {
      const commands: Partial<Record<GameAction, string>> = {
        answer: `submit ${value}`,
        join: 'join',
        stop: 'stop',
        score: 'score',
        status: 'score',
        command: value,
      };
      const command = commands[request.action];
      if (!command) return unsupportedAction();
      return handleBattleCommand(command);
    }

    return { status: 'not_executed', message: 'Не удалось определить обработчик текущей игры.' };
  }
}

const gameInteractionService = new GameInteractionService();
export default gameInteractionService;
