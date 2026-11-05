import { prisma } from '../../db/client.js';

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

function isGameKind(value: string): value is GameKind {
  return Object.hasOwn(gameCatalog, value);
}

const prompts: Record<GameKind, { text: string; answer?: string; hint?: string }> = {
  quiz: {
    text: 'Викторина: какая планета Солнечной системы самая большая? Ответь одним словом.',
    answer: 'юпитер',
  },
  riddle: {
    text: 'Загадка: зимой и летом одним цветом. Что это?',
    answer: 'ель',
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

function normalizeAnswer(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('ru-RU')
    .replace(/[ё]/gu, 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim();
}

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
    await prisma.gameSession.create({
      data: {
        conversationId,
        game: gameKind,
        data: JSON.stringify(prompts[gameKind]),
      },
    });
    return `${gameCatalog[gameKind]} началась!\n${prompts[gameKind].text}`;
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

    const data: unknown = JSON.parse(active.data);
    if (
      typeof data !== 'object' ||
      data === null ||
      !('answer' in data) ||
      typeof data.answer !== 'string'
    ) {
      throw new Error('Active game has invalid state');
    }
    if (normalizeAnswer(answer) !== normalizeAnswer(data.answer)) return null;

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
}

const gameService = new GameService();
export default gameService;
