import { logger } from '../../../logger/index.js';
import { isValidTimeZone } from '../../reminders/reminderDateTime.js';
import { DEFAULT_TIME_ZONE } from '../../settings/locationDefaults.js';
import timeService, { type CurrentTime } from '../../time/timeService.js';
import type { AITool } from '../AIProvider.js';

type TimeZoneSettings = {
  timeZone: string | null;
  locationTimeZone: string | null;
};

type ContextTimeZone = {
  timeZone: string | null;
  scope: 'chat' | 'user';
};

type CurrentDateTimeContext = ContextTimeZone & {
  checkAccess: () => Promise<{ allowed: true } | { allowed: false; message: string }>;
  getCurrentTime?: () => Promise<CurrentTime>;
  getTimeZone?: () => ContextTimeZone;
};

export function selectContextTimeZone(
  isChat: boolean,
  chatSettings: TimeZoneSettings,
  userSettings: TimeZoneSettings,
): ContextTimeZone {
  const settings = isChat ? chatSettings : userSettings;
  return {
    timeZone: settings.timeZone ?? settings.locationTimeZone,
    scope: isChat ? 'chat' : 'user',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatLocalTime(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes): string => {
    const value = parts.find((item) => item.type === type)?.value;
    if (!value) throw new Error(`Missing date/time component: ${type}`);
    return value;
  };
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    time: `${part('hour')}:${part('minute')}:${part('second')}`,
    weekday: part('weekday'),
    utc_offset: part('timeZoneName').replace(/^GMT/u, 'UTC'),
  };
}

/**
 * Даёт модели проверенное время внешнего сервиса в запрошенном часовом поясе.
 */
export function createCurrentDateTimeTool(context: CurrentDateTimeContext): AITool {
  return {
    name: 'get_current_datetime',
    description: [
      'Получи текущую дату, день недели и время из внешнего сервиса.',
      'При необходимости укажи часовой пояс IANA из запроса, например Europe/Moscow.',
      'Без него используется часовой пояс текущей беседы или личного диалога; если он не задан, используется Europe/Moscow по умолчанию.',
      'Всегда указывай часовой пояс из результата. Если default_used=true, обязательно сообщи, что часовой пояс не настроен и использована Москва по умолчанию.',
      'Если сервисы недоступны, сообщи об этом и не выдумывай текущую дату или время.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        time_zone: {
          type: 'string',
          maxLength: 128,
          description: 'Необязательный часовой пояс IANA, явно указанный или понятный из запроса.',
        },
      },
      additionalProperties: false,
    },
    async execute(input) {
      if (
        !isRecord(input) ||
        Object.keys(input).some((key) => key !== 'time_zone') ||
        (input.time_zone !== undefined &&
          (typeof input.time_zone !== 'string' ||
            input.time_zone.trim().length === 0 ||
            input.time_zone.length > 128))
      ) {
        logger.warn('Invalid AI current date/time request');
        return JSON.stringify({
          status: 'not_executed',
          message: 'Укажите корректный часовой пояс IANA или не передавайте его.',
        });
      }

      const access = await context.checkAccess();
      if (!access.allowed)
        return JSON.stringify({ status: 'not_executed', message: access.message });

      const requestedTimeZone =
        typeof input.time_zone === 'string' ? input.time_zone.trim() : undefined;
      const contextTimeZone = context.getTimeZone?.() ?? {
        timeZone: context.timeZone,
        scope: context.scope,
      };
      const timeZone = requestedTimeZone ?? contextTimeZone.timeZone ?? DEFAULT_TIME_ZONE;
      if (!isValidTimeZone(timeZone)) {
        logger.warn({ scope: context.scope }, 'Invalid current date/time timezone');
        return JSON.stringify({
          status: 'not_executed',
          message: 'Часовой пояс недействителен. Укажите корректный часовой пояс IANA.',
        });
      }

      let reading: CurrentTime;
      try {
        reading = await (context.getCurrentTime ?? (() => timeService.getCurrentTime()))();
      } catch (error) {
        logger.warn(
          { errorName: error instanceof Error ? error.name : 'UnknownError' },
          'Unable to retrieve current date and time',
        );
        return JSON.stringify({
          status: 'error',
          message:
            error instanceof AggregateError
              ? 'Не удалось получить текущую дату и время: оба сервиса недоступны или вернули некорректные данные.'
              : 'Не удалось получить текущую дату и время из сервиса.',
        });
      }

      try {
        return JSON.stringify({
          status: 'result',
          source: reading.source,
          utc_datetime: reading.instant.toISOString(),
          time_zone: timeZone,
          time_zone_source: requestedTimeZone
            ? 'requested'
            : contextTimeZone.timeZone !== null
              ? contextTimeZone.scope
              : 'default_moscow',
          settings_configured: contextTimeZone.timeZone !== null,
          default_used: !requestedTimeZone && contextTimeZone.timeZone === null,
          ...(requestedTimeZone || contextTimeZone.timeZone !== null
            ? {}
            : {
                note: `Часовой пояс не настроен; используется ${DEFAULT_TIME_ZONE} (Москва) по умолчанию.`,
              }),
          ...formatLocalTime(reading.instant, timeZone),
        });
      } catch (error) {
        logger.warn(
          { errorName: error instanceof Error ? error.name : 'UnknownError' },
          'Unable to format current date and time',
        );
        return JSON.stringify({
          status: 'error',
          message: 'Не удалось преобразовать полученную дату и время.',
        });
      }
    },
  };
}
