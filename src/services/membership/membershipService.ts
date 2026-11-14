import type { VK } from 'vk-io';
import { prisma } from '../../db/client.js';
import { logger } from '../../logger/index.js';
import { getLocalDateTime, resolveReminderTimeZone } from '../reminders/reminderDateTime.js';
import settingsService from '../settings/settingsService.js';

export type MembershipMemberType = 'user' | 'community';
export type MembershipEventType = 'join' | 'leave';
export type MembershipEventSource =
  | 'chat_invite_user'
  | 'chat_invite_user_by_link'
  | 'chat_invite_user_by_message_request'
  | 'chat_kick_user';

export type RecordMembershipEventInput = {
  conversationId: string;
  memberId: string;
  memberType: MembershipMemberType;
  type: MembershipEventType;
  eventId: string;
  source: MembershipEventSource;
  actorId?: string | null;
  occurredAt?: Date;
};

export type MembershipStats = {
  current: number;
  currentSource: 'vk' | 'db';
  joined: number;
  left: number;
  net: number;
  uniqueMembers: number;
  returningMembers: number;
  repeatJoins: number;
  period: { from: Date; to: Date; days: number };
  trackingSince: Date;
  timeZone: string;
  partial: boolean;
};

export type MembershipStatsInput = {
  conversationId: string;
  api?: VK['api'];
  days: number;
};

const MEMBERSHIP_SYNC_PAGE_SIZE = 200;
const MEMBERSHIP_SYNC_BATCH_SIZE = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function formatDays(days: number): string {
  const modulo100 = days % 100;
  const modulo10 = days % 10;
  if (modulo100 >= 11 && modulo100 <= 14) return `${days} дней`;
  if (modulo10 === 1) return `${days} день`;
  if (modulo10 >= 2 && modulo10 <= 4) return `${days} дня`;
  return `${days} дней`;
}

function formatLocalDate(date: Date, timeZone: string): string {
  const [year, month, day] = getLocalDateTime(date, timeZone).date.split('-');
  return `${day}.${month}.${year}`;
}

/**
 * Считает входы и выходы участников и поддерживает актуальность текущего состава.
 * Агрегаты не хранятся: они рассчитываются из MembershipEvent при каждом запросе.
 */
export class MembershipService {
  private api?: VK['api'];
  private readonly syncLocks = new Set<string>();

  setApi(api: VK['api']): void {
    this.api = api;
  }

  async recordEvent(input: RecordMembershipEventInput): Promise<boolean> {
    try {
      await prisma.membershipEvent.create({
        data: {
          conversationId: input.conversationId,
          memberId: input.memberId,
          memberType: input.memberType,
          type: input.type,
          eventId: input.eventId,
          source: input.source,
          actorId: input.actorId ?? null,
          occurredAt: input.occurredAt ?? new Date(),
        },
      });
      return true;
    } catch (error) {
      if (isUniqueConstraintError(error)) return false;
      throw error;
    }
  }

  /**
   * Обновляет ConversationMember по текущему списку VK не чаще раза в локальный день.
   * События MembershipEvent при этом не создаются.
   */
  async syncIfStale(input: { conversationId: string; api?: VK['api'] }): Promise<void> {
    if (this.syncLocks.has(input.conversationId)) return;
    this.syncLocks.add(input.conversationId);

    try {
      const api = input.api ?? this.api;
      if (!api) return;

      const settings = await settingsService.getChatSettings(input.conversationId);
      const timeZone = resolveReminderTimeZone(settings.timeZone, settings.locationTimeZone);
      const today = getLocalDateTime(new Date(), timeZone).date;
      const claimed = await prisma.chatSettings.updateMany({
        where: {
          conversationId: input.conversationId,
          OR: [{ membershipLastSyncDay: null }, { membershipLastSyncDay: { not: today } }],
        },
        data: { membershipLastSyncDay: today },
      });
      if (claimed.count === 0) return;

      const memberIds = await this.fetchMemberIds(api, Number(input.conversationId));
      await this.updatePresentMembers(input.conversationId, memberIds);
    } catch (error) {
      logger.warn(
        { err: error, conversationId: input.conversationId },
        'Unable to sync conversation membership',
      );
    } finally {
      this.syncLocks.delete(input.conversationId);
    }
  }

  async getStats(input: MembershipStatsInput): Promise<MembershipStats> {
    const settings = await settingsService.getChatSettings(input.conversationId);
    const timeZone = resolveReminderTimeZone(settings.timeZone, settings.locationTimeZone);
    const to = new Date();
    const from = new Date(to.getTime() - input.days * DAY_MS);
    const eventWhere = {
      conversationId: input.conversationId,
      occurredAt: { gte: from, lte: to },
    };

    const [joined, left, joinGroups] = await Promise.all([
      prisma.membershipEvent.count({ where: { ...eventWhere, type: 'join' } }),
      prisma.membershipEvent.count({ where: { ...eventWhere, type: 'leave' } }),
      prisma.membershipEvent.groupBy({
        by: ['memberId'],
        where: { ...eventWhere, type: 'join' },
        _count: { _all: true },
      }),
    ]);

    const api = input.api ?? this.api;
    let current: number;
    let currentSource: 'vk' | 'db';
    if (api) {
      try {
        const response = await api.messages.getConversationMembers({
          peer_id: Number(input.conversationId),
          count: 1,
        });
        if (!Number.isSafeInteger(response.count) || response.count < 0) {
          throw new Error('VK returned an invalid conversation member count');
        }
        current = response.count;
        currentSource = 'vk';
      } catch (error) {
        logger.warn(
          { err: error, conversationId: input.conversationId },
          'Unable to retrieve current conversation member count',
        );
        current = await this.countPresentMembers(input.conversationId);
        currentSource = 'db';
      }
    } else {
      current = await this.countPresentMembers(input.conversationId);
      currentSource = 'db';
    }

    const trackingSince = settings.membershipTrackingSince;
    return {
      current,
      currentSource,
      joined,
      left,
      net: joined - left,
      uniqueMembers: joinGroups.length,
      returningMembers: joinGroups.filter((group) => group._count._all > 1).length,
      repeatJoins: joined - joinGroups.length,
      period: { from, to, days: input.days },
      trackingSince,
      timeZone,
      partial: from.getTime() < trackingSince.getTime(),
    };
  }

  private async countPresentMembers(conversationId: string): Promise<number> {
    return prisma.conversationMember.count({
      where: { conversationId, isPresent: true },
    });
  }

  private async fetchMemberIds(api: VK['api'], peerId: number): Promise<Set<string>> {
    const memberIds = new Set<string>();
    let offset = 0;
    let total = 0;
    let fetched = 0;

    while (offset < total || offset === 0) {
      const page = await api.messages.getConversationMembers({
        peer_id: peerId,
        offset,
        count: MEMBERSHIP_SYNC_PAGE_SIZE,
      });
      total = page.count;
      fetched += page.items.length;
      for (const item of page.items) {
        if (Number.isSafeInteger(item.member_id) && item.member_id > 0) {
          memberIds.add(String(item.member_id));
        }
      }
      if (page.items.length === 0) break;
      offset += page.items.length;
      if (offset >= total) break;
    }

    if (total > 0 && fetched === 0) {
      throw new Error('VK returned an empty participant list for a non-empty conversation');
    }
    if (total > 0 && fetched < total) {
      throw new Error(`VK returned an incomplete participant list (${fetched}/${total})`);
    }
    return memberIds;
  }

  private async updatePresentMembers(
    conversationId: string,
    memberIds: Set<string>,
  ): Promise<void> {
    const now = new Date();
    const currentIds = [...memberIds];

    for (const batch of chunk(currentIds, MEMBERSHIP_SYNC_BATCH_SIZE)) {
      await prisma.$transaction(
        batch.map((vkUserId) =>
          prisma.conversationMember.upsert({
            where: { conversationId_vkUserId: { conversationId, vkUserId } },
            create: {
              conversationId,
              vkUserId,
              isPresent: true,
              firstJoinedAt: now,
              lastJoinedAt: now,
            },
            update: { isPresent: true, leftAt: null },
          }),
        ),
      );
    }

    const presentRows = await prisma.conversationMember.findMany({
      where: { conversationId, isPresent: true },
      select: { vkUserId: true },
    });
    const absentIds = presentRows
      .map(({ vkUserId }) => vkUserId)
      .filter((vkUserId) => !memberIds.has(vkUserId));

    for (const batch of chunk(absentIds, MEMBERSHIP_SYNC_BATCH_SIZE)) {
      await prisma.conversationMember.updateMany({
        where: {
          conversationId,
          isPresent: true,
          vkUserId: { in: batch },
        },
        data: { isPresent: false, leftAt: now },
      });
    }
  }
}

export function formatMembershipStats(stats: MembershipStats): string {
  const lines = [
    `📊 Участники за ${formatDays(stats.period.days)}`,
    `Сейчас: ${stats.current}`,
    `Вошло: ${stats.joined}`,
    `Вышло: ${stats.left}`,
    `Прирост: ${stats.net > 0 ? '+' : ''}${stats.net}`,
    `Уникальных участников: ${stats.uniqueMembers}`,
    `Повторных входов: ${stats.repeatJoins}`,
  ];
  if (stats.partial) {
    lines.push(`ℹ️ Учёт ведётся с ${formatLocalDate(stats.trackingSince, stats.timeZone)}.`);
  }
  if (stats.currentSource === 'db') {
    lines.push('ℹ️ VK недоступен, текущее число взято из данных бота и может быть неполным.');
  }
  if (stats.joined === 0 && stats.left === 0) {
    lines.push('За этот период входов и выходов не было.');
  }
  return lines.join('\n');
}

export default new MembershipService();
