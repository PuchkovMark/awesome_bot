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
  current: number | null;
  currentSource: 'vk' | 'unavailable' | 'db';
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

const DAY_MS = 24 * 60 * 60 * 1000;

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
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
 * Считает входы и выходы участников и запрашивает текущую численность у VK.
 * Агрегаты не хранятся: они рассчитываются из MembershipEvent при каждом запросе.
 */
export class MembershipService {
  private api?: VK['api'];

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
    let current: number | null = null;
    let currentSource: MembershipStats['currentSource'] = 'unavailable';
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
      }
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
}

export function formatMembershipStats(stats: MembershipStats): string {
  const lines = [
    `📊 Участники за ${formatDays(stats.period.days)}`,
    `Сейчас: ${stats.current ?? 'недоступно'}`,
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
  } else if (stats.currentSource === 'unavailable') {
    lines.push('ℹ️ VK недоступен, поэтому текущее число участников определить не удалось.');
  }
  if (stats.joined === 0 && stats.left === 0) {
    lines.push('За этот период входов и выходов не было.');
  }
  return lines.join('\n');
}

export default new MembershipService();
