import { prisma } from '../../db/client.js';
import type { Prisma } from '@prisma/client';
import config from '../../config/index.js';
import { logger } from '../../logger/index.js';
import { matchesVkPersonName, parseVkUserReference } from '../vk/vkMention.js';
import { cleanHistoryText } from './historyText.js';

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

export type ResolvedParticipant =
  { kind: 'user'; name: string; vkId: string; dbUserId: string } | { kind: 'bot'; name: string };

export type ParticipantCandidate = {
  kind: 'user' | 'bot';
  name: string;
  vkId?: string;
};

export type ParticipantResolution = {
  participants: ResolvedParticipant[];
  ambiguous: Array<{ reference: string; candidates: ParticipantCandidate[] }>;
  notFound: string[];
};

export const MAX_PARTICIPANTS = 5;

function participantCondition(
  participantUserIds: readonly string[] | undefined,
  includeBot: boolean | undefined,
): Prisma.MessageWhereInput {
  const userIds = participantUserIds ?? [];
  if (userIds.length === 0 && !includeBot) {
    return { role: { in: ['user', 'assistant'] } };
  }
  if (includeBot && userIds.length > 0) {
    return {
      OR: [{ role: 'assistant' }, { role: 'user', userId: { in: [...userIds] } }],
    };
  }
  if (includeBot) return { role: 'assistant' };
  return { role: 'user', userId: { in: [...userIds] } };
}

function normalizedName(value: string): string {
  return value.trim().toLocaleLowerCase('ru-RU');
}

function nameParts(value: string): [string, string] {
  const [first = '', ...rest] = value.trim().split(/\s+/u);
  return [first, rest.join(' ')];
}

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
  }): Promise<StoredMessage | null> {
    const { conversationId, vkUserId, displayName, role, provider } = params;
    const content = cleanHistoryText(params.content);
    if (!content) return null;

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
        replyToText: params.replyToText
          ? cleanHistoryText(params.replyToText) || undefined
          : undefined,
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
   * Находит авторов текущей беседы по именам, падежам или VK ID.
   * Пенёк и текущее имя персонажа определяются как синтетический участник.
   */
  async resolveConversationParticipants(
    conversationId: string,
    references: readonly string[],
    botNames: readonly string[] = [],
  ): Promise<ParticipantResolution> {
    const uniqueReferences = [
      ...new Set(references.map((reference) => reference.trim()).filter(Boolean)),
    ].slice(0, MAX_PARTICIPANTS);
    if (uniqueReferences.length === 0) {
      return { participants: [], ambiguous: [], notFound: [] };
    }

    const users = await prisma.user.findMany({
      where: {
        messages: {
          some: { conversationId, role: 'user' },
        },
      },
      select: { id: true, vkId: true, displayName: true },
    });
    const authorSamples = await prisma.message.findMany({
      where: {
        conversationId,
        role: 'user',
        userId: { in: users.map((user) => user.id) },
      },
      select: { userId: true, authorName: true },
      orderBy: { createdAt: 'desc' },
      distinct: ['userId'],
    });
    const authorNameByUser = new Map(
      authorSamples.flatMap((sample) =>
        sample.userId && sample.authorName ? [[sample.userId, sample.authorName] as const] : [],
      ),
    );
    const userCandidates = users.map((user) => ({
      kind: 'user' as const,
      name:
        user.displayName && user.displayName !== user.vkId
          ? user.displayName
          : (authorNameByUser.get(user.id) ?? user.vkId),
      vkId: user.vkId,
      dbUserId: user.id,
    }));
    const botAliases = new Set(
      ['пенёк', 'пенек', 'пенечек', 'бот', 'bot', ...botNames.map(normalizedName)].filter(Boolean),
    );
    const botName = 'Пенёк';

    const participants: ResolvedParticipant[] = [];
    const ambiguous: ParticipantResolution['ambiguous'] = [];
    const notFound: string[] = [];
    const addParticipant = (participant: ResolvedParticipant): void => {
      const key = participant.kind === 'bot' ? 'bot' : `user:${participant.dbUserId}`;
      if (
        !participants.some((existing) =>
          existing.kind === 'bot'
            ? key === 'bot'
            : existing.kind === 'user' && `user:${existing.dbUserId}` === key,
        )
      ) {
        participants.push(participant);
      }
    };

    for (const reference of uniqueReferences) {
      const parsed = parseVkUserReference(reference);
      if (parsed?.kind === 'id') {
        const matches = userCandidates.filter((user) => user.vkId === parsed.value);
        if (matches.length === 1 && matches[0]) {
          addParticipant({
            kind: 'user',
            name: matches[0].name,
            vkId: matches[0].vkId,
            dbUserId: matches[0].dbUserId,
          });
        } else if (matches.length > 1) {
          ambiguous.push({
            reference,
            candidates: matches.map((user) => ({
              kind: 'user',
              name: user.name,
              vkId: user.vkId,
            })),
          });
        } else {
          notFound.push(reference);
        }
        continue;
      }

      const nameReference = parsed?.kind === 'screenName' ? parsed.value : reference;
      const normalized = normalizedName(nameReference);
      const exactUsers = userCandidates.filter((user) => normalizedName(user.name) === normalized);
      const inflectedUsers = userCandidates.filter((user) => {
        const [first, last] = nameParts(user.name);
        return matchesVkPersonName(first, last, nameReference);
      });
      const matchedUsers = exactUsers.length > 0 ? exactUsers : inflectedUsers;
      const botMatch = botAliases.has(normalized);

      if (botMatch || matchedUsers.length > 0) {
        const candidates: ParticipantCandidate[] = [
          ...(botMatch ? [{ kind: 'bot' as const, name: botName }] : []),
          ...matchedUsers.map((user) => ({
            kind: 'user' as const,
            name: user.name,
            vkId: user.vkId,
          })),
        ];
        if (candidates.length > 1) {
          ambiguous.push({ reference, candidates });
        } else if (botMatch) {
          addParticipant({ kind: 'bot', name: botName });
        } else if (matchedUsers[0]) {
          addParticipant({
            kind: 'user',
            name: matchedUsers[0].name,
            vkId: matchedUsers[0].vkId,
            dbUserId: matchedUsers[0].dbUserId,
          });
        }
      } else {
        notFound.push(reference);
      }
    }

    return { participants, ambiguous, notFound };
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
    participantUserIds?: readonly string[];
    includeBot?: boolean;
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
      ...participantCondition(params.participantUserIds, params.includeBot),
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
