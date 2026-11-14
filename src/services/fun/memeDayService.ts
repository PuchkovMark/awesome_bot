import { prisma } from '../../db/client.js';
import config from '../../config/index.js';
import { logger } from '../../logger/index.js';

export type MemeDaySettings = {
  enabled: boolean;
  dailyTime: string;
  timezone: string;
  weeklyEnabled: boolean;
  allowNight: boolean;
  style: 'auto' | 'comic' | 'realistic' | 'cartoon' | 'absurd' | 'classic';
  allowParticipantMemes: boolean;
  participantFrequency: number;
  intensity: number;
  allowQuotes: boolean;
  manualEnabled: boolean;
  votingEnabled: boolean;
  excludedUserIds: string[];
  activeWithinHours: number;
};

const defaults: MemeDaySettings = {
  enabled: false,
  dailyTime: '20:00',
  timezone: config.MEMEDAY_TIMEZONE,
  weeklyEnabled: false,
  allowNight: false,
  style: 'auto',
  allowParticipantMemes: false,
  participantFrequency: 10,
  intensity: 50,
  allowQuotes: false,
  manualEnabled: true,
  votingEnabled: true,
  excludedUserIds: [],
  activeWithinHours: 48,
};

const styles = new Set<MemeDaySettings['style']>([
  'auto',
  'comic',
  'realistic',
  'cartoon',
  'absurd',
  'classic',
]);

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function parseSettings(value: string): MemeDaySettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error('Не удалось прочитать настройки «Мема дня».', { cause: error });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Настройки «Мема дня» имеют некорректный формат.');
  }
  const record = parsed as Record<string, unknown>;
  const result = { ...defaults };
  for (const key of [
    'enabled',
    'weeklyEnabled',
    'allowNight',
    'allowParticipantMemes',
    'allowQuotes',
    'manualEnabled',
    'votingEnabled',
  ] as const) {
    if (record[key] !== undefined) {
      if (typeof record[key] !== 'boolean') {
        throw new TypeError(`Настройка «${key}» имеет некорректный формат.`);
      }
      result[key] = record[key];
    }
  }
  if (record.dailyTime !== undefined) {
    if (
      typeof record.dailyTime !== 'string' ||
      !/^([01]\d|2[0-3]):[0-5]\d$/u.test(record.dailyTime)
    ) {
      throw new Error('В сохранённых настройках указано некорректное время.');
    }
    result.dailyTime = record.dailyTime;
  }
  if (record.timezone !== undefined) {
    if (typeof record.timezone !== 'string' || !isValidTimezone(record.timezone)) {
      throw new Error('В сохранённых настройках указана некорректная временная зона.');
    }
    result.timezone = record.timezone;
  }
  if (record.style !== undefined) {
    if (typeof record.style !== 'string' || !styles.has(record.style as MemeDaySettings['style'])) {
      throw new Error('В сохранённых настройках указан неизвестный стиль мема.');
    }
    result.style = record.style as MemeDaySettings['style'];
  }
  for (const key of ['participantFrequency', 'intensity', 'activeWithinHours'] as const) {
    if (record[key] !== undefined) {
      const min = key === 'activeWithinHours' ? 1 : 0;
      const max = key === 'activeWithinHours' ? 168 : 100;
      if (
        typeof record[key] !== 'number' ||
        !Number.isInteger(record[key]) ||
        record[key] < min ||
        record[key] > max
      ) {
        throw new Error(`Настройка «${key}» должна быть числом от ${min} до ${max}.`);
      }
      result[key] = record[key];
    }
  }
  if (record.excludedUserIds !== undefined) {
    if (
      !Array.isArray(record.excludedUserIds) ||
      record.excludedUserIds.length > 100 ||
      !record.excludedUserIds.every((id) => typeof id === 'string' && /^\d+$/u.test(id))
    ) {
      throw new Error('Список исключённых участников повреждён.');
    }
    result.excludedUserIds = record.excludedUserIds.map(String);
  }
  if (!result.allowNight && isNightTime(result.dailyTime)) {
    throw new Error('Ночное время задано, хотя ночные публикации отключены.');
  }
  return result;
}

function isNightTime(time: string): boolean {
  const hour = Number(time.slice(0, 2));
  return hour < 8 || hour >= 22;
}

export type MemeDayKind =
  'daily' | 'weekly' | 'group' | 'user' | 'event' | 'quote' | 'absurd' | 'prediction';

/**
 * Управляет расписанием мемов дня и недели, публикациями, архивом и голосованием бесед.
 */
export class MemeDayService {
  async getSettings(conversationId: string): Promise<MemeDaySettings> {
    const chat = await prisma.chatSettings.findUniqueOrThrow({
      where: { conversationId },
      select: { memeDaySettings: true },
    });
    return parseSettings(chat.memeDaySettings);
  }

  async updateSettings(
    conversationId: string,
    update: Partial<MemeDaySettings>,
  ): Promise<MemeDaySettings> {
    const chat = await prisma.chatSettings.findUniqueOrThrow({
      where: { conversationId },
      select: { memeDaySettings: true },
    });
    const current = parseSettings(chat.memeDaySettings);
    const settings = { ...current, ...update };
    if (!/^([01]\d|2[0-3]):[0-5]\d$/u.test(settings.dailyTime)) {
      throw new Error('Укажите время в формате ЧЧ:ММ, например 20:00.');
    }
    if (!isValidTimezone(settings.timezone)) {
      throw new Error('Укажите корректную временную зону IANA, например Europe/Moscow.');
    }
    if (!styles.has(settings.style)) {
      throw new Error('Стиль: auto, comic, realistic, cartoon, absurd или classic.');
    }
    if (!settings.allowNight && isNightTime(settings.dailyTime)) {
      throw new Error('Для публикаций с 22:00 до 08:00 сначала включите night on.');
    }
    const validated = parseSettings(JSON.stringify(settings));
    await prisma.chatSettings.update({
      where: { conversationId },
      data: {
        memeDaySettings: JSON.stringify(validated),
        ...(update.weeklyEnabled === undefined
          ? {}
          : { memeDayWeeklyEnabled: update.weeklyEnabled }),
      },
    });
    return validated;
  }

  async listEnabledChats(): Promise<Array<{ conversationId: string; settings: MemeDaySettings }>> {
    const chats = await prisma.chatSettings.findMany({
      where: {
        conversation: { isGroup: true },
      },
      select: { conversationId: true, memeDaySettings: true },
    });
    const result: Array<{ conversationId: string; settings: MemeDaySettings }> = [];
    for (const { conversationId, memeDaySettings } of chats) {
      try {
        const settings = parseSettings(memeDaySettings);
        if (settings.enabled || settings.weeklyEnabled) result.push({ conversationId, settings });
      } catch (error) {
        logger.error(
          { err: error, conversationId },
          'Invalid meme day settings; skipping conversation',
        );
      }
    }
    return result;
  }

  async claimScheduled(
    conversationId: string,
    scheduleKey: string,
    kind: 'daily' | 'weekly',
  ): Promise<string | null> {
    const now = new Date();
    let existing = await prisma.memeDayPublication.findUnique({ where: { scheduleKey } });
    if (!existing) {
      try {
        existing = await prisma.memeDayPublication.create({
          data: {
            conversationId,
            kind,
            topic: 'pending',
            caption: 'pending',
            scheduleKey,
            status: 'pending',
          },
        });
      } catch (error) {
        if (
          typeof error !== 'object' ||
          error === null ||
          !('code' in error) ||
          error.code !== 'P2002'
        ) {
          throw error;
        }
        existing = await prisma.memeDayPublication.findUnique({ where: { scheduleKey } });
        if (!existing) throw error;
      }
    }
    if (
      existing.conversationId !== conversationId ||
      existing.status === 'published' ||
      existing.status === 'skipped'
    ) {
      return null;
    }
    if (existing.attempts >= 3 || (existing.nextAttemptAt && existing.nextAttemptAt > now)) {
      return null;
    }
    const claimed = await prisma.memeDayPublication.updateMany({
      where: {
        id: existing.id,
        attempts: { lt: 3 },
        OR: [
          { status: { in: ['pending', 'failed'] } },
          { status: 'generating', lockUntil: { lte: now } },
        ],
        AND: [
          { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
          { OR: [{ lockUntil: null }, { lockUntil: { lte: now } }] },
        ],
      },
      data: {
        status: 'generating',
        attempts: { increment: 1 },
        lockUntil: new Date(now.getTime() + 15 * 60_000),
      },
    });
    return claimed.count === 1 ? existing.id : null;
  }

  async beginManual(conversationId: string, kind: MemeDayKind): Promise<string> {
    const created = await prisma.memeDayPublication.create({
      data: { conversationId, kind, topic: 'pending', caption: 'pending', status: 'generating' },
      select: { id: true },
    });
    return created.id;
  }

  async manualGenerationAllowed(conversationId: string): Promise<boolean> {
    const since = new Date(Date.now() - 60 * 60_000);
    const recent = await prisma.memeDayPublication.count({
      where: {
        conversationId,
        status: { in: ['generating', 'published'] },
        createdAt: { gte: since },
        scheduleKey: null,
      },
    });
    return recent < 3;
  }

  async complete(
    id: string,
    result: {
      kind: MemeDayKind;
      topic: string;
      caption: string;
      funOutputId: string;
      attachment: string;
    },
  ): Promise<void> {
    await prisma.memeDayPublication.update({
      where: { id },
      data: {
        ...result,
        imageUrl: `https://vk.com/${result.attachment}`,
        status: 'published',
        lockUntil: null,
        nextAttemptAt: null,
      },
    });
  }

  async markSkipped(id: string): Promise<void> {
    await prisma.memeDayPublication.update({
      where: { id },
      data: { status: 'skipped', lockUntil: null, nextAttemptAt: null },
    });
  }

  async markFailed(id: string, retryable: boolean): Promise<void> {
    const item = await prisma.memeDayPublication.findUniqueOrThrow({
      where: { id },
      select: { attempts: true, scheduleKey: true },
    });
    if (!item.scheduleKey || !retryable || item.attempts >= 3) {
      await prisma.memeDayPublication.update({
        where: { id },
        data: { status: 'failed', lockUntil: null, nextAttemptAt: null },
      });
      return;
    }
    await prisma.memeDayPublication.update({
      where: { id },
      data: {
        status: 'failed',
        lockUntil: null,
        nextAttemptAt: new Date(Date.now() + item.attempts * 10 * 60_000),
      },
    });
  }

  async deleteFailedManual(id: string): Promise<void> {
    await prisma.memeDayPublication.deleteMany({
      where: { id, scheduleKey: null, status: 'generating' },
    });
  }

  async vote(
    conversationId: string,
    publicationId: string,
    vkUserId: string,
    value: 'laugh' | 'fire' | 'neutral' | 'dislike',
  ): Promise<{ score: number; count: number } | null> {
    const publication = await prisma.memeDayPublication.findFirst({
      where: { id: publicationId, conversationId, status: 'published' },
      select: { id: true },
    });
    if (!publication) return null;
    await prisma.memeDayVote.upsert({
      where: { publicationId_vkUserId: { publicationId, vkUserId } },
      create: { publicationId, vkUserId, value },
      update: { value, createdAt: new Date() },
    });
    const votes = await prisma.memeDayVote.findMany({
      where: { publicationId },
      select: { value: true },
    });
    return {
      score: votes.reduce(
        (score, vote) =>
          score +
          (vote.value === 'fire'
            ? 2
            : vote.value === 'laugh'
              ? 1
              : vote.value === 'dislike'
                ? -1
                : 0),
        0,
      ),
      count: votes.length,
    };
  }

  async history(conversationId: string, take = 5) {
    return prisma.memeDayPublication.findMany({
      where: { conversationId, status: 'published' },
      orderBy: { createdAt: 'desc' },
      take: Math.max(1, Math.min(20, take)),
      include: { votes: { select: { value: true } } },
    });
  }

  async top(conversationId: string, take = 5) {
    const publications = await prisma.memeDayPublication.findMany({
      where: { conversationId, status: 'published' },
      orderBy: { createdAt: 'desc' },
      include: { votes: { select: { value: true } } },
    });
    return publications
      .map((publication) => ({
        ...publication,
        score: publication.votes.reduce(
          (score, vote) =>
            score +
            (vote.value === 'fire'
              ? 2
              : vote.value === 'laugh'
                ? 1
                : vote.value === 'dislike'
                  ? -1
                  : 0),
          0,
        ),
      }))
      .sort((a, b) => b.score - a.score || b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, Math.max(1, Math.min(10, take)));
  }

  async latest(conversationId: string) {
    return prisma.memeDayPublication.findFirst({
      where: { conversationId, status: 'published' },
      orderBy: { createdAt: 'desc' },
    });
  }

  async latestWeekly(conversationId: string) {
    return prisma.memeDayPublication.findFirst({
      where: { conversationId, status: 'published', kind: 'weekly' },
      orderBy: { createdAt: 'desc' },
    });
  }

  async random(conversationId: string) {
    const where = { conversationId, status: 'published' };
    const count = await prisma.memeDayPublication.count({ where });
    if (count === 0) return null;
    return prisma.memeDayPublication.findFirst({
      where,
      orderBy: { createdAt: 'desc' },
      skip: Math.floor(Math.random() * count),
    });
  }
}

const memeDayService = new MemeDayService();
export default memeDayService;
