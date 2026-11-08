import type {
  ContextFact,
  DateTimeContext,
  ProviderRequest,
  RealWorldContextProvider,
} from './types.js';

function getPart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((part) => part.type === type)?.value ?? '';
}

export function getDateTimeContext(
  now: Date,
  timeZone: string,
  timeZoneSource: DateTimeContext['timeZoneSource'] = 'project-default',
): DateTimeContext {
  const dateParts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const year = Number(getPart(dateParts, 'year'));
  const month = Number(getPart(dateParts, 'month'));
  const day = Number(getPart(dateParts, 'day'));
  const localDate = `${year.toString().padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const timeParts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const localTime = `${getPart(timeParts, 'hour')}:${getPart(timeParts, 'minute')}:${getPart(timeParts, 'second')}`;
  const weekDay = new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    weekday: 'long',
  }).format(now);
  const offset = getPart(
    new Intl.DateTimeFormat('en', { timeZone, timeZoneName: 'longOffset' }).formatToParts(now),
    'timeZoneName',
  ).replace(/^GMT/u, 'UTC');
  const weekdayNumber = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const daysUntilSaturday = (6 - weekdayNumber + 7) % 7;
  const newYear = new Date(Date.UTC(year + 1, 0, 1));
  const currentLocalDay = new Date(Date.UTC(year, month - 1, day));
  const daysUntilNewYear = Math.round((newYear.getTime() - currentLocalDay.getTime()) / 86_400_000);
  const tomorrowDate = new Date(Date.UTC(year, month - 1, day + 1));
  const tomorrow = `${tomorrowDate.getUTCFullYear()}-${String(tomorrowDate.getUTCMonth() + 1).padStart(2, '0')}-${String(tomorrowDate.getUTCDate()).padStart(2, '0')}`;

  return {
    utcNow: now.toISOString(),
    localDate,
    localTime,
    dayOfWeek: weekDay,
    timeZone,
    utcOffset: offset || 'UTC',
    timeZoneSource,
    tomorrow,
    daysUntilSaturday,
    daysUntilNewYear,
  };
}

/**
 * Формирует актуальный календарный и временной контекст с учётом часового пояса.
 */
export class DateTimeProvider implements RealWorldContextProvider {
  readonly category = 'date_time' as const;

  async getContext(request: ProviderRequest): Promise<ContextFact<DateTimeContext>> {
    return {
      category: this.category,
      source: 'runtime',
      retrievedAt: request.now.toISOString(),
      data: getDateTimeContext(request.now, request.timeZone, request.timeZoneSource),
    };
  }
}
