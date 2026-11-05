import { prisma } from '../../db/client.js';
import type { Prisma } from '@prisma/client';
import config from '../../config/index.js';
import { logger } from '../../logger/index.js';

export type StoredMessage = {
  id: string;
  role: string;
  content: string;
  provider?: string | null;
  tokens?: number | null;
  createdAt: Date;
};

/**
 * MemoryService — отвечает за сохранение и получение истории сообщений.
 * Хранит сообщения в Prisma/SQLite, удаляет устаревший контекст и выдаёт
 * контекст для отправки в AI с учётом лимита токенов и TTL.
 */
export class MemoryService {
  private ttlHours: number;
  private maxTokens: number;

  constructor() {
    this.ttlHours = Math.max(1, Math.min(24, config.CONTEXT_TTL_HOURS));
    this.maxTokens = config.MAX_HISTORY_TOKENS;
  }

  private estimateTokens(text: string): number {
    return Math.max(1, Math.ceil(text.length / 4));
  }

  private async ensureUser(vkId: string, displayName?: string) {
    return prisma.user.upsert({
      where: { vkId },
      create: { vkId, displayName },
      update: displayName ? { displayName } : {},
    });
  }

  private async ensureConversation(id: string, title?: string, isGroup = false) {
    let conv = await prisma.conversation.findUnique({ where: { id } });
    if (!conv) {
      conv = await prisma.conversation.create({ data: { id, title, isGroup } });
      logger.debug({ conversationId: id }, 'Created new conversation');
    }
    return conv;
  }

  /**
   * Сохраняет сообщение в БД. Если user/conversation не существуют — создаёт их.
   */
  async addMessage(params: {
    conversationId: string;
    vkUserId?: string;
    displayName?: string;
    role: string;
    content: string;
    provider?: string;
    tokens?: number;
  }): Promise<StoredMessage> {
    const { conversationId, vkUserId, displayName, role, content, provider } = params;

    if (vkUserId) await this.ensureUser(vkUserId, displayName);
    await this.ensureConversation(conversationId);

    const tokens = params.tokens ?? this.estimateTokens(content);

    const msg = await prisma.message.create({
      data: {
        conversationId,
        userId: vkUserId
          ? (await prisma.user.findUnique({ where: { vkId: vkUserId } }))?.id
          : undefined,
        role,
        content,
        provider,
        tokens,
      },
    });

    return {
      id: msg.id,
      role: msg.role,
      content: msg.content,
      provider: msg.provider ?? null,
      tokens: msg.tokens ?? null,
      createdAt: msg.createdAt,
    };
  }

  /**
   * Возвращает контекст для конкретного пользователя в разговоре.
   * Контекст фильтруется по TTL и обрезается по суммарному числу токенов.
   */
  async getContextForUser(conversationId: string, vkUserId: string) {
    const ttlDate = new Date(Date.now() - this.ttlHours * 60 * 60 * 1000);

    const user = await prisma.user.findUnique({ where: { vkId: vkUserId } });
    if (!user) return [];

    const messages = await prisma.message.findMany({
      where: {
        conversationId,
        userId: user.id,
        createdAt: { gte: ttlDate },
      },
      orderBy: { createdAt: 'desc' },
      take: config.MAX_HISTORY_MESSAGES,
    });

    const result: StoredMessage[] = [];
    let tokenSum = 0;

    for (const m of messages) {
      const t = m.tokens ?? this.estimateTokens(m.content);
      if (tokenSum + t > this.maxTokens) break;
      tokenSum += t;
      result.push({
        id: m.id,
        role: m.role,
        content: m.content,
        provider: m.provider ?? null,
        tokens: m.tokens ?? null,
        createdAt: m.createdAt,
      });
    }

    return result.reverse();
  }

  /**
   * Shared messages from this VK chat only; never includes another conversation's data.
   */
  async getRecentChatContext(conversationId: string, take = 8) {
    const messages = await prisma.message.findMany({
      where: {
        conversationId,
        role: 'user',
        createdAt: { gte: new Date(Date.now() - this.ttlHours * 60 * 60 * 1000) },
      },
      include: { user: { select: { vkId: true, displayName: true } } },
      orderBy: { createdAt: 'desc' },
      take: Math.max(1, Math.min(20, take)),
    });

    return messages.reverse().map((message) => ({
      speaker:
        message.user?.displayName && message.user.displayName !== message.user.vkId
          ? message.user.displayName
          : 'Участник',
      content: message.content,
    }));
  }

  async getRecentConversationMessages(conversationId: string, since: Date) {
    const messages = await prisma.message.findMany({
      where: {
        conversationId,
        role: { in: ['user', 'assistant'] },
        createdAt: { gte: since },
      },
      include: { user: { select: { vkId: true, displayName: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    return messages.reverse().map((message) => ({
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      speaker:
        message.role === 'assistant'
          ? 'Пенёк'
          : message.user?.displayName && message.user.displayName !== message.user.vkId
            ? message.user.displayName
            : 'Участник',
    }));
  }

  async getRecentConversationUsers(conversationId: string, since: Date) {
    const messages = await prisma.message.findMany({
      where: {
        conversationId,
        role: 'user',
        createdAt: { gte: since },
        userId: { not: null },
      },
      select: {
        user: { select: { vkId: true, displayName: true } },
      },
      distinct: ['userId'],
    });

    return messages.flatMap(({ user }) =>
      user ? [{ vkId: user.vkId, displayName: user.displayName }] : [],
    );
  }

  async getActiveGroupConversationIds(since: Date, take = 50): Promise<string[]> {
    const conversations = await prisma.message.groupBy({
      by: ['conversationId'],
      where: {
        createdAt: { gte: since },
        conversation: { isGroup: true },
      },
      _max: { createdAt: true },
      orderBy: { _max: { createdAt: 'desc' } },
      take: Math.max(1, Math.min(50, take)),
    });
    return conversations.map(({ conversationId }) => conversationId);
  }

  async updateUserDisplayName(vkId: string, displayName: string) {
    await prisma.user.upsert({
      where: { vkId },
      create: { vkId, displayName },
      update: { displayName },
    });
  }

  /**
   * Удаляет сообщения старше TTL часов.
   */
  async cleanupOldContext(): Promise<number> {
    const ttlDate = new Date(Date.now() - this.ttlHours * 60 * 60 * 1000);
    const res = await prisma.message.deleteMany({ where: { createdAt: { lt: ttlDate } } });
    logger.info({ deleted: res.count }, 'Old messages cleaned up');
    return res.count;
  }

  /**
   * Полностью очищает историю пользователя. Если указан `conversationId`, очищает только в разговоре.
   */
  async clearUserHistory(vkUserId: string, conversationId?: string): Promise<number> {
    const user = await prisma.user.findUnique({ where: { vkId: vkUserId } });
    if (!user) return 0;
    const where: Prisma.MessageWhereInput = { userId: user.id };
    if (conversationId) where.conversationId = conversationId;
    const res = await prisma.message.deleteMany({ where });
    logger.info({ vkUserId, deleted: res.count }, 'User history cleared');
    return res.count;
  }
}

const memoryService = new MemoryService();
export default memoryService;
