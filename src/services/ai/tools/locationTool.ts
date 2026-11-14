import { logger } from '../../../logger/index.js';
import type { AITool } from '../AIProvider.js';
import { DEFAULT_CITY, DEFAULT_TIME_ZONE } from '../../settings/locationDefaults.js';
import locationService, {
  type ClearLocationResult,
  type LocationScope,
  type LocationSummary,
  type SetCityResult,
  type SetTimeZoneResult,
} from '../../settings/locationService.js';

type LocationOperations = Pick<
  typeof locationService,
  'getLocationSummary' | 'setCity' | 'setTimeZone' | 'clearLocation'
>;

type LocationToolContext = {
  scope: LocationScope;
  conversationId: string;
  senderId: string;
  canManage: () => Promise<boolean>;
  checkAccess: () => Promise<{ allowed: true } | { allowed: false; message: string }>;
  operations?: LocationOperations;
  onChanged?: (settings: LocationSummary['settings']) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length >= 2 &&
    value.length <= 100 &&
    /^[\p{L}\p{N} .,'’()\-\u2010-\u2015]+$/u.test(value)
  );
}

function publicSummary(summary: LocationSummary) {
  return {
    city: summary.city,
    time_zone: summary.timeZone,
    city_configured: summary.cityConfigured,
    time_zone_configured: summary.timeZoneConfigured,
    default_city: DEFAULT_CITY.name,
    default_time_zone: DEFAULT_TIME_ZONE,
    settings_configured: summary.cityConfigured && summary.timeZoneConfigured,
  };
}

function candidatesText(candidates: SetCityResult & { status: 'ambiguous' }): string {
  return candidates.candidates
    .slice(0, 5)
    .map((candidate) => {
      const details = [candidate.region, candidate.country].filter(Boolean).join(', ');
      return `${candidate.name}${details ? ` — ${details}` : ''}`;
    })
    .join('; ');
}

/**
 * Позволяет модели показать или изменить город и часовой пояс текущего диалога.
 * Изменения сохраняются только по явной просьбе пользователя.
 */
export function createLocationTool(context: LocationToolContext): AITool {
  const operations = context.operations ?? locationService;
  const targetId = context.scope === 'chat' ? context.conversationId : context.senderId;

  const invalid = (message: string) => {
    logger.warn(
      { scope: context.scope, senderId: context.senderId },
      'Invalid location tool request',
    );
    return JSON.stringify({ status: 'not_executed', message });
  };

  return {
    name: 'manage_location',
    description: [
      'Покажи или измени город и часовой пояс текущей беседы или личного диалога.',
      'Используй set_city, set_timezone или clear только по явной просьбе пользователя; не угадывай город и не сохраняй случайные значения.',
      'В беседе менять настройки может только администратор беседы или бота; в личном диалоге — сам пользователь.',
      `Если настройки не заданы, приложение использует ${DEFAULT_CITY.name} (${DEFAULT_TIME_ZONE}). Сообщи об этом пользователю.`,
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['show', 'set_city', 'set_timezone', 'clear'],
        },
        city: {
          type: 'string',
          description: 'Название города для set_city.',
        },
        region: {
          type: 'string',
          description: 'Регион или область для уточнения города.',
        },
        country_code: {
          type: 'string',
          pattern: '^[A-Za-z]{2}$',
          description: 'Двухбуквенный код страны для уточнения города.',
        },
        time_zone: {
          type: 'string',
          description: 'IANA-часовой пояс, например Europe/Moscow.',
        },
        target: {
          type: 'string',
          enum: ['city', 'timezone', 'all'],
          description: 'Что сбросить при action=clear; по умолчанию all.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    async execute(input) {
      if (
        !isRecord(input) ||
        Object.keys(input).some(
          (key) =>
            key !== 'action' &&
            key !== 'city' &&
            key !== 'region' &&
            key !== 'country_code' &&
            key !== 'time_zone' &&
            key !== 'target',
        ) ||
        typeof input.action !== 'string' ||
        !['show', 'set_city', 'set_timezone', 'clear'].includes(input.action)
      ) {
        return invalid('Укажите action: show, set_city, set_timezone или clear.');
      }
      if (
        (input.city !== undefined && !validText(input.city)) ||
        (input.region !== undefined && !validText(input.region)) ||
        (input.country_code !== undefined &&
          (typeof input.country_code !== 'string' || !/^[A-Za-z]{2}$/u.test(input.country_code))) ||
        (input.time_zone !== undefined &&
          (typeof input.time_zone !== 'string' ||
            input.time_zone.length > 128 ||
            input.time_zone.trim().length === 0)) ||
        (input.target !== undefined &&
          (typeof input.target !== 'string' || !['city', 'timezone', 'all'].includes(input.target)))
      ) {
        return invalid('Проверьте параметры города, часового пояса и target.');
      }

      const access = await context.checkAccess();
      if (!access.allowed)
        return JSON.stringify({ status: 'not_executed', message: access.message });

      if (input.action === 'show') {
        const summary = await operations.getLocationSummary(context.scope, targetId);
        return JSON.stringify({
          status: 'result',
          action: 'show',
          ...publicSummary(summary),
        });
      }

      if (context.scope === 'chat' && !(await context.canManage())) {
        return JSON.stringify({
          status: 'not_allowed',
          message:
            'Менять город и часовой пояс беседы могут только администраторы беседы или бота.',
        });
      }

      if (input.action === 'clear') {
        const target =
          input.target === 'city' || input.target === 'timezone' || input.target === 'all'
            ? input.target
            : 'all';
        const result: ClearLocationResult = await operations.clearLocation(
          context.scope,
          targetId,
          target,
        );
        if (result.status === 'error') {
          return JSON.stringify({ status: 'error', message: result.message });
        }
        context.onChanged?.(result.summary.settings);
        return JSON.stringify({
          status: 'result',
          action: 'clear',
          target,
          ...publicSummary(result.summary),
        });
      }

      if (input.action === 'set_city') {
        if (typeof input.city !== 'string') return invalid('Укажите город для set_city.');
        const result: SetCityResult = await operations.setCity(context.scope, targetId, {
          name: input.city.trim(),
          ...(typeof input.region === 'string' ? { region: input.region.trim() } : {}),
          ...(typeof input.country_code === 'string'
            ? { countryCode: input.country_code.toUpperCase() }
            : {}),
        });
        if (result.status === 'not_found' || result.status === 'error') {
          return JSON.stringify({ status: result.status, message: result.message });
        }
        if (result.status === 'ambiguous') {
          return JSON.stringify({
            status: 'needs_clarification',
            message: `Найдено несколько населённых пунктов: ${candidatesText(result)}. Уточните регион или страну.`,
          });
        }
        context.onChanged?.(result.summary.settings);
        return JSON.stringify({
          status: 'result',
          action: 'set_city',
          location: {
            name: result.location.name,
            region: result.location.region ?? null,
            country: result.location.country ?? null,
            time_zone: result.location.timeZone ?? null,
          },
          ...publicSummary(result.summary),
        });
      }

      if (typeof input.time_zone !== 'string') {
        return invalid('Укажите time_zone для set_timezone.');
      }
      const result: SetTimeZoneResult = await operations.setTimeZone(
        context.scope,
        targetId,
        input.time_zone.trim(),
      );
      if (result.status === 'invalid' || result.status === 'error') {
        return JSON.stringify({ status: result.status, message: result.message });
      }
      context.onChanged?.(result.summary.settings);
      return JSON.stringify({
        status: 'result',
        action: 'set_timezone',
        ...publicSummary(result.summary),
      });
    },
  };
}
