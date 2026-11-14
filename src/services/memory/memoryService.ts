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

export type HistoryMessage = {
  id: string;
  role: string;
  content: string;
  createdAt: Date;
  sentAt: Date | null;
  speaker: string;
  replyToAuthorName: string | null;
  replyToText: string | null;
  attachments: string[];
};

export type HistoryPage = {
  messages: HistoryMessage[];
  hasMore: boolean;
  oldestAvailable: Date | null;
};

const proposalAttributionQuestionPattern =
  /(?:^|[^\p{L}\p{N}])кто(?:$|[^\p{L}\p{N}])[\s\S]{0,100}предлож\p{L}*/iu;
const proposalCuePattern =
  /предлож\p{L}*|предлаг\p{L}*|давайте|давай|может(?:\s+быть)?|можно|а\s+если|есть\s+идея|мой\s+вариант|(?:поедем|поехать|съездим|съездить)\s+(?:в|на)/iu;

function parseAttachmentTypes(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string').slice(0, 5)
      : [];
  } catch {
    return [];
  }
}

/**
 * MemoryService — отвечает за сохранение и получение истории сообщений.
 * Хранит сообщения в Prisma/SQLite, удаляет устаревший контекст и выдаёт
 * контекст для отправки в AI с учётом лимита токенов и TTL.
 */
/**
 * Сохраняет, выбирает и очищает личную и общую историю сообщений для контекста диалогов.
 */
export class MemoryService {
  private readonly ttlHours: number;
  private readonly maxTokens: number;

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
    vkMessageId?: number;
    conversationMessageId?: number;
    sentAt?: Date;
    fromId?: number;
    authorName?: string;
    replyToVkMessageId?: number;
    replyToConversationMessageId?: number;
    replyToFromId?: number;
    replyToAuthorName?: string;
    replyToText?: string;
    attachments?: string;
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
        vkMessageId: params.vkMessageId,
        conversationMessageId: params.conversationMessageId,
        sentAt: params.sentAt ?? new Date(),
        fromId: params.fromId,
        authorName: params.authorName ?? (role === 'assistant' ? 'Пенёк' : displayName),
        replyToVkMessageId: params.replyToVkMessageId,
        replyToConversationMessageId: params.replyToConversationMessageId,
        replyToFromId: params.replyToFromId,
        replyToAuthorName: params.replyToAuthorName,
        replyToText: params.replyToText,
        attachments: params.attachments,
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
   * Shared user and assistant messages from this VK chat only.
   */
  async getRecentChatContext(conversationId: string, take = config.MAX_HISTORY_MESSAGES) {
    const messages = await prisma.message.findMany({
      where: {
        conversationId,
        role: { in: ['user', 'assistant'] },
        createdAt: { gte: new Date(Date.now() - this.ttlHours * 60 * 60 * 1000) },
      },
      include: { user: { select: { vkId: true, displayName: true } } },
      orderBy: { createdAt: 'desc' },
      take: Math.max(1, Math.min(config.MAX_HISTORY_MESSAGES, take)),
    });

    return messages.toReversed().map((message) => ({
      id: message.id,
      role: message.role,
      speaker:
        message.role === 'assistant'
          ? 'Пенёк'
          : message.user?.displayName && message.user.displayName !== message.user.vkId
            ? message.user.displayName
            : 'Участник',
      authorId: message.role === 'assistant' ? undefined : (message.user?.vkId ?? 'unknown'),
      content: message.content,
      createdAt: message.createdAt,
    }));
  }

  /**
   * Возвращает страницу сохранённой истории текущей беседы или личного диалога.
   * В личном диалоге выборка дополнительно ограничивается текущим пользователем.
   */
  async getHistoryPage(params: {
    conversationId: string;
    vkUserId?: string;
    before?: Date;
    from?: Date;
    limit: number;
    excludeIds?: readonly string[];
  }): Promise<HistoryPage> {
    const limit = Math.max(1, Math.min(50, params.limit));
    let userId: string | undefined;
    if (params.vkUserId) {
      const user = await prisma.user.findUnique({ where: { vkId: params.vkUserId } });
      if (!user) return { messages: [], hasMore: false, oldestAvailable: null };
      userId = user.id;
    }

    const baseWhere: Prisma.MessageWhereInput = {
      conversationId: params.conversationId,
      role: { in: ['user', 'assistant'] },
      ...(userId ? { userId } : {}),
    };
    const excludeIds = [...new Set(params.excludeIds)].filter(Boolean);
    const where: Prisma.MessageWhereInput = {
      ...baseWhere,
      ...(params.before || params.from
        ? {
            createdAt: {
              ...(params.from ? { gte: params.from } : {}),
              ...(params.before ? { lte: params.before } : {}),
            },
          }
        : {}),
      ...(excludeIds.length > 0 ? { id: { notIn: excludeIds } } : {}),
    };

    const [rows, oldest] = await Promise.all([
      prisma.message.findMany({
        where,
        include: { user: { select: { vkId: true, displayName: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      }),
      prisma.message.findFirst({
        where: baseWhere,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { createdAt: true },
      }),
    ]);

    const hasMore = rows.length > limit;
    const messages = (hasMore ? rows.slice(0, limit) : rows).toReversed().map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      sentAt: message.sentAt,
      speaker:
        message.role === 'assistant'
          ? 'Пенёк'
          : message.user?.displayName && message.user.displayName !== message.user.vkId
            ? message.user.displayName
            : (message.authorName ?? 'Участник'),
      replyToAuthorName: message.replyToAuthorName,
      replyToText: message.replyToText,
      attachments: parseAttachmentTypes(message.attachments),
    }));

    return {
      messages,
      hasMore,
      oldestAvailable: oldest?.createdAt ?? null,
    };
  }

  async getProposalHistoryForQuestion(
    conversationId: string,
    query: string,
  ): Promise<
    | {
        id: string;
        speaker: string;
        authorId: string;
        content: string;
        createdAt: Date;
      }[]
    | undefined
  > {
    if (!proposalAttributionQuestionPattern.test(query)) return undefined;

    const messages = await prisma.message.findMany({
      where: {
        conversationId,
        role: 'user',
        createdAt: { gte: new Date(Date.now() - this.ttlHours * 60 * 60 * 1000) },
      },
      include: { user: { select: { vkId: true, displayName: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    return messages
      .filter((message) => proposalCuePattern.test(message.content))
      .slice(0, 10)
      .reverse()
      .map((message) => ({
        id: message.id,
        speaker:
          message.user?.displayName && message.user.displayName !== message.user.vkId
            ? message.user.displayName
            : 'Участник',
        authorId: message.user?.vkId ?? 'unknown',
        content: message.content,
        createdAt: message.createdAt,
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

    return messages.toReversed().map((message) => ({
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
      take: 100,
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
    const weeklyMemeCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const expired = await prisma.message.deleteMany({
      where: {
        createdAt: { lt: ttlDate },
        conversation: {
          OR: [{ settings: { is: { memeDayWeeklyEnabled: false } } }, { settings: { is: null } }],
        },
      },
    });
    const oldWeeklyContext = await prisma.message.deleteMany({
      where: { createdAt: { lt: weeklyMemeCutoff } },
    });
    const deleted = expired.count + oldWeeklyContext.count;
    logger.info({ deleted }, 'Old messages cleaned up');
    return deleted;
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
