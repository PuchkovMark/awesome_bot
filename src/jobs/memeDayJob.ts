import cron from 'node-cron';
import { prisma } from '../db/client.js';
import { logger } from '../logger/index.js';
import memeDayService from '../services/fun/memeDayService.js';
type ScheduleKind = 'daily' | 'weekly';

function localParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
    weekday: values.weekday,
  };
}

function isoWeek(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  value.setUTCDate(value.getUTCDate() + 4 - (value.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(value.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((value.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${value.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function getMemeDaySchedule(
  now: Date,
  conversationId: string,
  settings: { enabled: boolean; weeklyEnabled: boolean; dailyTime: string; timezone: string },
): Array<{ key: string; kind: ScheduleKind }> {
  const local = localParts(now, settings.timezone);
  if (local.time !== settings.dailyTime) return [];
  if (settings.weeklyEnabled && local.weekday === 'Sun') {
    return [{ key: `${conversationId}:weekly:${isoWeek(local.date)}`, kind: 'weekly' }];
  }
  const result: Array<{ key: string; kind: ScheduleKind }> = [];
  if (settings.enabled) {
    result.push({ key: `${conversationId}:daily:${local.date}`, kind: 'daily' });
  }
  return result;
}

export function startMemeDayJob(
  publish: (
    conversationId: string,
    publicationId: string,
    kind: ScheduleKind,
    scheduleKey: string,
  ) => Promise<boolean>,
): void {
  let running = false;
  cron.schedule('* * * * *', async () => {
    if (running) return;
    running = true;
    try {
      const now = new Date();
      const chats = await memeDayService.listEnabledChats();
      for (const { conversationId, settings } of chats) {
        const schedules = getMemeDaySchedule(now, conversationId, settings);
        for (const schedule of schedules) {
          const publicationId = await memeDayService.claimScheduled(
            conversationId,
            schedule.key,
            schedule.kind,
          );
          if (!publicationId) continue;
          try {
            const activeSince = new Date(now.getTime() - settings.activeWithinHours * 60 * 60_000);
            const activity = await prisma.message.count({
              where: {
                conversationId,
                role: 'user',
                createdAt: { gte: activeSince },
              },
            });
            if (activity === 0) {
              await memeDayService.markSkipped(publicationId);
              continue;
            }
            const posted = await publish(
              conversationId,
              publicationId,
              schedule.kind,
              schedule.key,
            );
            if (!posted) await memeDayService.markSkipped(publicationId);
          } catch (error) {
            logger.error(
              { err: error, conversationId, scheduleKey: schedule.key },
              'Meme day scheduled publication failed',
            );
            await memeDayService.markFailed(publicationId, true);
          }
        }
      }
    } catch (error) {
      logger.error({ err: error }, 'Meme day scheduler failed');
    } finally {
      running = false;
    }
  });
  logger.info('Meme day scheduler scheduled');
}
