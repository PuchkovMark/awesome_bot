import { prisma } from '../../db/client.js';
import { getAIProvider } from '../ai/providerFactory.js';
import settingsService from '../settings/settingsService.js';
import config from '../../config/index.js';
import {
  buildRiddlePrompt,
  changeRiddleDifficulty,
  getRiddleDifficulty,
  getRiddleDifficultyLabel,
  normalizeGameAnswer,
  parseGeneratedRiddle,
  type GeneratedRiddle,
  type RiddleDifficulty,
} from './riddleGeneration.js';

const gameCatalog = {
  quiz: 'Викторина',
  riddle: 'Загадки',
  word: 'Угадай слово',
  truth: 'Правда или действие',
  who: 'Кто скорее всего?',
  association: 'Ассоциации',
  adventure: 'Текстовое приключение',
  detective: 'Детективное расследование',
  story: 'Интерактивная история',
} as const;

export type GameKind = keyof typeof gameCatalog;
type GamePrompt = { text: string; answer?: string; answers?: string[]; hint?: string };

function isGameKind(value: string): value is GameKind {
  return Object.hasOwn(gameCatalog, value);
}

const prompts: Partial<Record<GameKind, GamePrompt>> = {
  quiz: {
    text: 'Викторина: какая планета Солнечной системы самая большая? Ответь одним словом.',
    answer: 'юпитер',
  },
  word: {
    text: 'Угадай слово: это фрукт, обычно жёлтый, который любят обезьяны.',
    answer: 'банан',
  },
  truth: {
    text: 'Правда или действие: участники по очереди пишут «правда» или «действие», а ведущий придумывает безопасный вопрос или задание.',
  },
  who: {
    text: 'Кто скорее всего? Задайте группе вопрос, начинающийся с «Кто скорее всего…», и обсудите ответ.',
  },
  association: {
    text: 'Ассоциации: первое слово — «космос». Напишите ассоциацию к предыдущему слову, не повторяясь.',
  },
  adventure: {
    text: 'Приключение начинается: вы просыпаетесь у входа в загадочный лес. Напишите действие, чтобы выбрать, что произойдёт дальше.',
  },
  detective: {
    text: 'Дело открыто: из запертой комнаты пропала картина. На столе остались мокрый след и открытое окно. Предложите версию расследования.',
  },
  story: {
    text: 'Интерактивная история: каждый участник добавляет одно предложение, продолжая сюжет. Начало: «В старом маяке внезапно загорелся свет».',
  },
};

export class GameService {
  list(): string {
    return Object.entries(gameCatalog)
      .map(([id, name]) => `${id} — ${name}`)
      .join('\n');
  }

  async start(conversationId: string, game: string): Promise<string> {
    if (!isGameKind(game)) {
      return `Укажите игру:\n${this.list()}\n\nПример: /games quiz`;
    }

    const active = await prisma.gameSession.findFirst({
      where: { conversationId, state: 'active' },
      select: { id: true },
    });
    if (active) return 'В этой беседе уже идёт игра. Завершите её командой /games stop.';

    const gameKind = game;
    const prompt =
      gameKind === 'riddle' ? await this.generateRiddle(conversationId, 2) : prompts[gameKind];
    if (!prompt) throw new Error(`Missing game prompt: ${gameKind}`);
    await prisma.gameSession.create({
      data: {
        conversationId,
        game: gameKind,
        data: JSON.stringify(prompt),
      },
    });
    return `${gameCatalog[gameKind]} началась!\n${gameKind === 'riddle' ? `Сложность: ${getRiddleDifficultyLabel(2)} (2/5).\nЗагадка: ` : ''}${prompt.text}`;
  }

  async changeRiddleDifficulty(conversationId: string, change: -1 | 1): Promise<string> {
    const active = await prisma.gameSession.findFirst({
      where: { conversationId, game: 'riddle', state: 'active' },
      orderBy: { startedAt: 'desc' },
    });
    if (!active) return 'В этой беседе сейчас нет активной игры в загадки.';

    const currentData = this.parseSessionData(active.data);
    const currentDifficulty = getRiddleDifficulty(currentData.difficulty);
    const nextDifficulty = changeRiddleDifficulty(currentDifficulty, change);
    if (nextDifficulty === currentDifficulty) {
      return `Уже установлена ${getRiddleDifficultyLabel(currentDifficulty)} сложность (${currentDifficulty}/5).`;
    }

    const riddle = await this.generateRiddle(conversationId, nextDifficulty);
    const update = await prisma.gameSession.updateMany({
      where: { id: active.id, state: 'active' },
      data: { data: JSON.stringify(riddle) },
    });
    if (update.count === 0) return 'Игра уже завершилась, сложность изменить нельзя.';
    return `Сложность изменена: ${getRiddleDifficultyLabel(nextDifficulty)} (${nextDifficulty}/5).\nНовая загадка: ${riddle.text}`;
  }

  async getRiddleDifficulty(conversationId: string): Promise<string> {
    const active = await prisma.gameSession.findFirst({
      where: { conversationId, game: 'riddle', state: 'active' },
      orderBy: { startedAt: 'desc' },
    });
    if (!active) return 'В этой беседе сейчас нет активной игры в загадки.';
    const difficulty = getRiddleDifficulty(this.parseSessionData(active.data).difficulty);
    return `Текущая сложность: ${getRiddleDifficultyLabel(difficulty)} (${difficulty}/5). Команды: /games harder, /games easier.`;
  }

  async stop(conversationId: string): Promise<string> {
    const active = await prisma.gameSession.findFirst({
      where: { conversationId, state: 'active' },
      orderBy: { startedAt: 'desc' },
    });
    if (!active) return 'В этой беседе сейчас нет активной игры.';
    await prisma.gameSession.update({
      where: { id: active.id },
      data: { state: 'finished', endedAt: new Date() },
    });
    return 'Игра завершена.';
  }

  async handleAnswer(
    conversationId: string,
    vkUserId: string,
    answer: string,
  ): Promise<string | null> {
    const active = await prisma.gameSession.findFirst({
      where: {
        conversationId,
        state: 'active',
        game: { in: ['quiz', 'riddle', 'word'] },
      },
      orderBy: { startedAt: 'desc' },
    });
    if (!active) return null;

    const data = this.parseSessionData(active.data);
    const expectedAnswers =
      Array.isArray(data.answers) && data.answers.every((value) => typeof value === 'string')
        ? data.answers
        : typeof data.answer === 'string'
          ? [data.answer]
          : [];
    if (expectedAnswers.length === 0) throw new Error('Active game has invalid answer state');
    const normalizedAnswer = normalizeGameAnswer(answer);
    if (!expectedAnswers.some((expected) => normalizeGameAnswer(expected) === normalizedAnswer)) {
      return null;
    }

    await prisma.gameScore.upsert({
      where: { sessionId_vkUserId: { sessionId: active.id, vkUserId } },
      create: { sessionId: active.id, vkUserId, points: 1 },
      update: { points: { increment: 1 } },
    });
    await prisma.gameSession.update({
      where: { id: active.id },
      data: { state: 'finished', endedAt: new Date() },
    });
    await prisma.achievement.upsert({
      where: { vkUserId_code: { vkUserId, code: 'game_first_win' } },
      create: { vkUserId, code: 'game_first_win' },
      update: {},
    });
    const user = await prisma.user.findUnique({
      where: { vkId: vkUserId },
      select: { displayName: true },
    });
    const winner = user?.displayName || 'Участник';
    return `Верно! Победитель: ${winner}. Начните следующую игру командой /games <игра>.`;
  }

  async leaderboard(): Promise<string> {
    const scores = await prisma.gameScore.groupBy({
      by: ['vkUserId'],
      _sum: { points: true },
      orderBy: { _sum: { points: 'desc' } },
      take: 10,
    });
    if (scores.length === 0) return 'Таблица лидеров пока пуста.';
    return scores
      .map((score, index) => `${index + 1}. ${score.vkUserId} — ${score._sum.points ?? 0}`)
      .join('\n');
  }

  private async generateRiddle(
    conversationId: string,
    difficulty: RiddleDifficulty,
  ): Promise<GeneratedRiddle> {
    const previousSessions = await prisma.gameSession.findMany({
      where: { conversationId, game: 'riddle' },
      orderBy: { startedAt: 'desc' },
      take: 10,
      select: { data: true },
    });
    const previousRiddles = previousSessions.flatMap(({ data }) => {
      const text = this.parseSessionData(data).text;
      return typeof text === 'string' ? [text] : [];
    });
    const providerName = (await settingsService.getAppSetting('ai_provider')) || config.AI_PROVIDER;
    const response = await getAIProvider(providerName).send(
      [
        {
          role: 'system',
          content:
            'Ты создаёшь загадки для игры. Не сообщай ответы в тексте загадки. Верни только JSON указанной формы, без Markdown и дополнительного текста.',
        },
        { role: 'user', content: buildRiddlePrompt(difficulty, previousRiddles) },
      ],
      { maxTokens: 300, temperature: 0.9 },
    );
    const riddle = parseGeneratedRiddle(response.content, difficulty);
    await prisma.apiUsage.create({
      data: {
        conversationId,
        provider: response.provider || providerName,
        feature: 'game_riddle',
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
      },
    });
    return riddle;
  }

  private parseSessionData(data: string): Record<string, unknown> {
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch (err) {
      throw new Error('Active game has invalid state', { cause: err });
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('Active game has invalid state');
    }
    return value as Record<string, unknown>;
  }
}

const gameService = new GameService();
export default gameService;
