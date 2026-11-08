import axios from 'axios';
import config from '../../config/index.js';
import type { RealWorldLocation } from '../settings/settingsService.js';
import { AsyncTtlCache } from './asyncTtlCache.js';
import type {
  ContextFact,
  LocationResolution,
  ProviderRequest,
  RealWorldContextProvider,
  WeatherContextData,
  WeatherCurrent,
  WeatherDay,
} from './types.js';

const geocodingUrl = 'https://geocoding-api.open-meteo.com/v1/search';
const forecastUrl = 'https://api.open-meteo.com/v1/forecast';
const failureCooldownMs = 30_000;

export type JsonGetter = (url: string, params: Record<string, string | number>) => Promise<unknown>;

interface Retrieved<T> {
  value: T;
  retrievedAt: string;
  expiresAt: string;
}

async function axiosGet(url: string, params: Record<string, string | number>): Promise<unknown> {
  const response = await axios.get<unknown>(url, {
    params,
    timeout: 12_000,
    maxContentLength: 2 * 1024 * 1024,
  });
  return response.data;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizeText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('ru-RU')
    .replace(/[ё]/gu, 'е')
    .replace(/\s+/gu, ' ')
    .trim();
}

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function validateLocation(value: unknown): RealWorldLocation | undefined {
  const item = record(value);
  if (!item) return undefined;
  const name = string(item.name);
  const latitude = number(item.latitude);
  const longitude = number(item.longitude);
  if (
    !name ||
    latitude === undefined ||
    longitude === undefined ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return undefined;
  }
  const timeZone = string(item.timezone);
  const countryCode = string(item.country_code)?.toUpperCase();
  const population = number(item.population);
  return {
    name,
    latitude,
    longitude,
    ...(countryCode && /^[A-Z]{2}$/u.test(countryCode) ? { countryCode } : {}),
    ...(string(item.admin1) ? { region: string(item.admin1) } : {}),
    ...(timeZone && isValidTimeZone(timeZone) ? { timeZone } : {}),
    ...(population !== undefined ? { population } : {}),
  };
}

function locationQueryVariants(query: string): string[] {
  const normalized = query.trim();
  const variants = new Set([normalized]);
  if (normalized.length < 3) return [...variants];
  if (normalized.endsWith('е')) {
    variants.add(normalized.slice(0, -1));
    variants.add(`${normalized.slice(0, -1)}а`);
  }
  if (normalized.endsWith('и')) {
    variants.add(`${normalized.slice(0, -1)}ь`);
    variants.add(`${normalized.slice(0, -1)}я`);
  }
  if (normalized.endsWith('у')) {
    variants.add(normalized.slice(0, -1));
    variants.add(`${normalized.slice(0, -1)}а`);
  }
  if (normalized.endsWith('ю')) {
    variants.add(normalized.slice(0, -1));
    variants.add(`${normalized.slice(0, -1)}я`);
  }
  return [...variants];
}

function wmoCondition(value: unknown): string | undefined {
  const code = number(value);
  if (code === undefined) return undefined;
  const conditions: Record<number, string> = {
    0: 'ясно',
    1: 'преимущественно ясно',
    2: 'переменная облачность',
    3: 'пасмурно',
    45: 'туман',
    48: 'изморозь и туман',
    51: 'слабая морось',
    53: 'морось',
    55: 'сильная морось',
    56: 'слабая ледяная морось',
    57: 'сильная ледяная морось',
    61: 'слабый дождь',
    63: 'дождь',
    65: 'сильный дождь',
    66: 'слабый ледяной дождь',
    67: 'сильный ледяной дождь',
    71: 'слабый снег',
    73: 'снег',
    75: 'сильный снег',
    77: 'снежная крупа',
    80: 'слабый ливень',
    81: 'ливень',
    82: 'сильный ливень',
    85: 'слабый снежный заряд',
    86: 'сильный снежный заряд',
    95: 'гроза',
    96: 'гроза с небольшим градом',
    99: 'гроза с сильным градом',
  };
  return conditions[code];
}

function windDirection(value: unknown): string | undefined {
  const degrees = number(value);
  if (degrees === undefined) return undefined;
  const directions = ['С', 'СВ', 'В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ'];
  return directions[Math.round((((degrees % 360) + 360) % 360) / 45) % directions.length];
}

function getOptionalArray(data: Record<string, unknown>, key: string): unknown[] {
  const value = data[key];
  return Array.isArray(value) ? value : [];
}

/**
 * Сообщает, что геокодер не нашёл населённый пункт по запросу пользователя.
 */
export class LocationNotFoundError extends Error {
  constructor(query: string) {
    super(`Не удалось найти населённый пункт «${query}».`);
    this.name = 'LocationNotFoundError';
  }
}

/**
 * Сообщает, что геокодирование вернуло несколько подходящих мест и требуется выбор.
 */
export class AmbiguousLocationError extends Error {
  constructor(
    readonly query: string,
    readonly candidates: RealWorldLocation[],
  ) {
    super(`Найдено несколько мест для запроса «${query}».`);
    this.name = 'AmbiguousLocationError';
  }
}

/**
 * Получает координаты, текущую погоду и прогноз Open-Meteo, кэшируя внешние запросы.
 */
export class OpenMeteoProvider implements RealWorldContextProvider {
  readonly category = 'weather' as const;
  private readonly geocodeCache = new AsyncTtlCache<RealWorldLocation[]>(200);
  private readonly currentCache = new AsyncTtlCache<Retrieved<WeatherCurrent>>(500);
  private readonly forecastCache = new AsyncTtlCache<Retrieved<WeatherDay[]>>(500);

  constructor(private readonly getJson: JsonGetter = axiosGet) {}

  async resolveLocation(query: string): Promise<LocationResolution> {
    const trimmed = query.trim();
    if (trimmed.length < 2 || trimmed.length > 100) {
      throw new Error('Название места должно содержать от 2 до 100 символов.');
    }
    const candidates = (
      await Promise.all(locationQueryVariants(trimmed).map((variant) => this.geocode(variant)))
    ).flat();
    const uniqueCandidates = [
      ...new Map(
        candidates.map((candidate) => [
          `${normalizeText(candidate.name)}:${candidate.countryCode}:${candidate.latitude}:${candidate.longitude}`,
          candidate,
        ]),
      ).values(),
    ];
    if (uniqueCandidates.length === 0) throw new LocationNotFoundError(trimmed);

    const exact = uniqueCandidates.filter((candidate) =>
      locationQueryVariants(trimmed).some(
        (variant) => normalizeText(candidate.name) === normalizeText(variant),
      ),
    );
    if (exact.length === 1) return { location: exact[0] };
    if (exact.length > 1) {
      const ranked = exact.toSorted(
        (first, second) => (second.population ?? 0) - (first.population ?? 0),
      );
      if (
        (ranked[0].population ?? 0) >= 10_000 &&
        (ranked[0].population ?? 0) >= (ranked[1].population ?? 0) * 10
      ) {
        return { location: ranked[0] };
      }
      return { ambiguous: ranked.slice(0, 5) };
    }
    return { ambiguous: uniqueCandidates.slice(0, 5) };
  }

  async getContext(request: ProviderRequest): Promise<ContextFact<WeatherContextData> | undefined> {
    if (!request.weatherPeriod || !request.location) return undefined;
    const period = request.weatherPeriod;
    const needsCurrent = period === 'current' || period === 'today';
    const needsForecast = period !== 'current';
    const [current, days] = await Promise.all([
      needsCurrent ? this.getCurrent(request.location) : undefined,
      needsForecast ? this.getForecast(request.location) : undefined,
    ]);
    const retrievalTimes = [current?.retrievedAt, days?.retrievedAt].filter(
      (value): value is string => value !== undefined,
    );
    const expiryTimes = [current?.expiresAt, days?.expiresAt].filter(
      (value): value is string => value !== undefined,
    );

    return {
      category: this.category,
      source: 'Open-Meteo',
      retrievedAt: retrievalTimes.sort()[0] ?? request.now.toISOString(),
      ...(expiryTimes.length ? { expiresAt: expiryTimes.sort()[0] } : {}),
      data: {
        location: request.location.name,
        period,
        ...(current
          ? {
              current: current.value,
              currentRetrievedAt: current.retrievedAt,
            }
          : {}),
        ...(days
          ? {
              days: this.selectDays(
                days.value,
                period,
                request.now,
                request.location.timeZone ?? request.timeZone,
              ),
              forecastRetrievedAt: days.retrievedAt,
            }
          : {}),
      },
    };
  }

  private async geocode(query: string): Promise<RealWorldLocation[]> {
    return this.geocodeCache.get(
      normalizeText(query),
      7 * 24 * 60 * 60_000,
      async () => {
        const response = record(
          await this.getJson(geocodingUrl, {
            name: query,
            count: 5,
            language: 'ru',
            format: 'json',
          }),
        );
        if (!response) throw new Error('Open-Meteo вернул некорректный ответ геокодирования.');
        return getOptionalArray(response, 'results')
          .map(validateLocation)
          .filter((location): location is RealWorldLocation => location !== undefined);
      },
      failureCooldownMs,
    );
  }

  private getCurrent(location: RealWorldLocation): Promise<Retrieved<WeatherCurrent>> {
    const key = this.locationKey(location);
    return this.currentCache.get(
      key,
      config.REAL_WORLD_CURRENT_WEATHER_CACHE_SECONDS * 1000,
      async () => {
        const response = record(
          await this.getJson(forecastUrl, {
            latitude: location.latitude,
            longitude: location.longitude,
            current:
              'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,pressure_msl,wind_speed_10m,wind_direction_10m',
            timezone: location.timeZone ?? 'auto',
          }),
        );
        const current = record(response?.current);
        if (!current) throw new Error('Open-Meteo не вернул текущую погоду.');
        const retrievedAt = new Date().toISOString();
        return {
          value: {
            temperatureC: number(current.temperature_2m),
            feelsLikeC: number(current.apparent_temperature),
            condition: wmoCondition(current.weather_code),
            windSpeedKmh: number(current.wind_speed_10m),
            windDirection: windDirection(current.wind_direction_10m),
            humidityPercent: number(current.relative_humidity_2m),
            pressureHpa: number(current.pressure_msl),
            precipitationMm: number(current.precipitation),
          },
          retrievedAt,
          expiresAt: new Date(
            Date.parse(retrievedAt) + config.REAL_WORLD_CURRENT_WEATHER_CACHE_SECONDS * 1000,
          ).toISOString(),
        };
      },
      failureCooldownMs,
    );
  }

  private getForecast(location: RealWorldLocation): Promise<Retrieved<WeatherDay[]>> {
    const key = this.locationKey(location);
    return this.forecastCache.get(
      key,
      config.REAL_WORLD_FORECAST_CACHE_SECONDS * 1000,
      async () => {
        const response = record(
          await this.getJson(forecastUrl, {
            latitude: location.latitude,
            longitude: location.longitude,
            daily:
              'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,rain_sum,snowfall_sum,wind_speed_10m_max,wind_direction_10m_dominant',
            forecast_days: 7,
            timezone: location.timeZone ?? 'auto',
          }),
        );
        const daily = record(response?.daily);
        const dates = getOptionalArray(daily ?? {}, 'time');
        if (!daily || dates.length === 0) {
          throw new Error('Open-Meteo не вернул прогноз погоды.');
        }
        const retrievedAt = new Date().toISOString();
        const fields = {
          code: getOptionalArray(daily, 'weather_code'),
          min: getOptionalArray(daily, 'temperature_2m_min'),
          max: getOptionalArray(daily, 'temperature_2m_max'),
          rainProbability: getOptionalArray(daily, 'precipitation_probability_max'),
          rain: getOptionalArray(daily, 'rain_sum'),
          snow: getOptionalArray(daily, 'snowfall_sum'),
          wind: getOptionalArray(daily, 'wind_speed_10m_max'),
          direction: getOptionalArray(daily, 'wind_direction_10m_dominant'),
        };
        const value = dates.flatMap((date, index) => {
          if (typeof date !== 'string') return [];
          const day: WeatherDay = {
            date,
            condition: wmoCondition(fields.code[index]),
            minTemperatureC: number(fields.min[index]),
            maxTemperatureC: number(fields.max[index]),
            precipitationProbabilityPercent: number(fields.rainProbability[index]),
            rainMm: number(fields.rain[index]),
            snowfallCm: number(fields.snow[index]),
            maxWindSpeedKmh: number(fields.wind[index]),
            dominantWindDirection: windDirection(fields.direction[index]),
          };
          return [day];
        });
        return {
          value,
          retrievedAt,
          expiresAt: new Date(
            Date.parse(retrievedAt) + config.REAL_WORLD_FORECAST_CACHE_SECONDS * 1000,
          ).toISOString(),
        };
      },
      failureCooldownMs,
    );
  }

  private locationKey(location: RealWorldLocation): string {
    return `${location.latitude.toFixed(4)}:${location.longitude.toFixed(4)}:${location.timeZone ?? 'auto'}`;
  }

  private selectDays(
    days: WeatherDay[],
    period: NonNullable<ProviderRequest['weatherPeriod']>,
    now: Date,
    timeZone: string,
  ): WeatherDay[] {
    if (period === 'today') return days.slice(0, 1);
    if (period === 'tomorrow') return days.slice(1, 2);
    if (period === 'after_tomorrow') return days.slice(2, 3);
    if (period === 'week') return days;
    if (period !== 'weekend') return [];

    const parts = new Intl.DateTimeFormat('en', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((item) => item.type === type)?.value);
    const year = part('year');
    const month = part('month');
    const date = part('day');
    const weekday = new Date(Date.UTC(year, month - 1, date)).getUTCDay();
    const startOffset = weekday === 0 ? 0 : weekday === 6 ? 0 : 6 - weekday;
    const saturday = new Date(Date.UTC(year, month - 1, date + startOffset));
    const sunday = new Date(
      Date.UTC(year, month - 1, date + (weekday === 0 ? 0 : startOffset + 1)),
    );
    const weekendDates = new Set([
      saturday.toISOString().slice(0, 10),
      sunday.toISOString().slice(0, 10),
    ]);
    return days.filter((day) => weekendDates.has(day.date));
  }
}
