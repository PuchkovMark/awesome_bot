import axios from 'axios';
import PQueue from 'p-queue';
import { logger } from '../../logger/index.js';
import { isValidTimeZone } from '../reminders/reminderDateTime.js';

export type WeatherAttribution = 'open_meteo' | 'met_norway' | 'geonames' | 'openstreetmap';

export type WeatherLocation = {
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  countryCode?: string;
  region?: string;
  district?: string;
  timeZone?: string;
  attribution?: WeatherAttribution;
};

export type WeatherLocationQuery = {
  name: string;
  countryCode?: string;
  country?: string;
  region?: string;
};

export type LocationResolution =
  | { status: 'found'; location: WeatherLocation }
  | { status: 'ambiguous'; candidates: WeatherLocation[]; attribution: WeatherAttribution }
  | { status: 'not_found'; message: string };

export type WeatherPoint = {
  timeUtc: string;
  temperatureC: number;
  apparentTemperatureC?: number;
  humidityPercent?: number;
  windSpeedMs?: number;
  condition?: string;
  conditionCode?: string;
  conditionPeriod?: string;
  precipitationMm?: number;
  precipitationPeriod?: string;
  precipitationProbabilityPercent?: number;
};

type WeatherSeries = {
  source: 'open_meteo' | 'met_norway';
  fetchedAt: string;
  issuedAt?: string;
  current?: WeatherPoint;
  forecast: WeatherPoint[];
};

type MetCacheValue =
  | { status: 'valid'; series: WeatherSeries; lastModified?: string }
  | { status: 'invalid'; lastModified?: string };

export type WeatherResult = {
  source: WeatherSeries['source'];
  fetchedAt: string;
  issuedAt?: string;
  current: WeatherPoint;
  forecast: WeatherPoint[];
};

export type WeatherHttpResponse = {
  data: unknown;
  status: number;
  expires?: string;
  lastModified?: string;
};

export type WeatherHttpRequest = (
  url: string,
  options: {
    params: Record<string, string | number>;
    headers?: Record<string, string>;
    allowNotModified?: boolean;
  },
) => Promise<WeatherHttpResponse>;

type CacheEntry<T> = { value: T; expiresAt: number };

const TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const GEOCODING_CACHE_MS = 24 * 60 * 60_000;
const OPEN_METEO_CACHE_MS = 15 * 60_000;
const MET_MIN_CACHE_MS = 3 * 60 * 60_000;
const MAX_CACHE_ENTRIES = 256;
const MAX_QUEUE_SIZE = 20;
const OPEN_METEO_GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const PHOTON_GEOCODING_URL = 'https://photon.komoot.io/api/';
const OPEN_METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const MET_FORECAST_URL = 'https://api.met.no/weatherapi/locationforecast/2.0/compact';
const USER_AGENT = 'awesome_bot/0.1 (https://github.com/PuchkovMark/awesome_bot)';

const WMO_CONDITIONS: Record<number, string> = {
  0: 'ясно',
  1: 'преимущественно ясно',
  2: 'переменная облачность',
  3: 'пасмурно',
  45: 'туман',
  48: 'туман с изморозью',
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

class RequestCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly pending = new Map<string, Promise<T>>();

  constructor(
    private readonly now: () => number,
    private readonly preserveUnexpired = false,
  ) {}

  async get(key: string, load: (previous?: T) => Promise<CacheEntry<T>>): Promise<T> {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > this.now()) return entry.value;
    const pending = this.pending.get(key);
    if (pending) return pending;

    if (!entry && this.entries.size + this.pending.size >= MAX_CACHE_ENTRIES) {
      const removable = [...this.entries].find(
        ([, cached]) => !this.preserveUnexpired || cached.expiresAt <= this.now(),
      );
      if (!removable) throw new Error('Weather cache is full');
      this.entries.delete(removable[0]);
    }

    const request = load(entry?.value)
      .then((loaded) => {
        this.entries.delete(key);
        this.entries.set(key, loaded);
        return loaded.value;
      })
      .finally(() => {
        this.pending.delete(key);
      });
    this.pending.set(key, request);
    return request;
  }
}

export class GeocodingUnavailableError extends Error {
  constructor() {
    super('Location services are unavailable');
    this.name = 'GeocodingUnavailableError';
  }
}

export class WeatherUnavailableError extends Error {
  constructor() {
    super('Weather services are unavailable');
    this.name = 'WeatherUnavailableError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, limit = 100): string | undefined {
  if (typeof value !== 'string') return undefined;
  const result = value
    .replaceAll(/\p{Cc}/gu, ' ')
    .trim()
    .slice(0, limit);
  return result || undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nonNegative(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && number >= 0 ? number : undefined;
}

function percent(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && number >= 0 && number <= 100 ? number : undefined;
}

function normalize(value: string): string {
  return value
    .normalize('NFKD')
    .replaceAll(/\p{M}/gu, '')
    .toLocaleLowerCase('ru-RU')
    .replaceAll('ё', 'е')
    .replaceAll(/\s+/gu, ' ')
    .trim();
}

function utcTimestamp(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)
  ) {
    return undefined;
  }
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ||
    instant.toISOString().slice(0, 19) !== value.slice(0, 19)
    ? undefined
    : instant.toISOString();
}

function unixTimestamp(value: unknown): string | undefined {
  const seconds = finiteNumber(value);
  if (seconds === undefined || !Number.isInteger(seconds)) return undefined;
  const instant = new Date(seconds * 1000);
  return Number.isNaN(instant.getTime()) ? undefined : instant.toISOString();
}

function validCoordinates(latitude: unknown, longitude: unknown): boolean {
  const lat = finiteNumber(latitude);
  const lon = finiteNumber(longitude);
  return (
    lat !== undefined && lat >= -90 && lat <= 90 && lon !== undefined && lon >= -180 && lon <= 180
  );
}

export function isValidWeatherCoordinates(latitude: unknown, longitude: unknown): boolean {
  return validCoordinates(latitude, longitude);
}

function parseOpenMeteoLocation(value: unknown): WeatherLocation | undefined {
  if (!isRecord(value)) return undefined;
  const name = text(value.name);
  const latitude = finiteNumber(value.latitude);
  const longitude = finiteNumber(value.longitude);
  if (
    !name ||
    latitude === undefined ||
    longitude === undefined ||
    !validCoordinates(latitude, longitude)
  ) {
    return undefined;
  }
  const timeZone = text(value.timezone, 128);
  const countryCode = text(value.country_code, 16)?.toUpperCase();
  return {
    name,
    latitude,
    longitude,
    country: text(value.country),
    region: text(value.admin1),
    district: text(value.admin2),
    countryCode: countryCode && /^[A-Z]{2}$/u.test(countryCode) ? countryCode : undefined,
    timeZone: timeZone && isValidTimeZone(timeZone) ? timeZone : undefined,
    attribution: 'geonames',
  };
}

function parsePhotonLocation(value: unknown): WeatherLocation | undefined {
  if (!isRecord(value) || !isRecord(value.properties) || !isRecord(value.geometry))
    return undefined;
  const properties = value.properties;
  if (
    properties.osm_key !== 'place' ||
    !['city', 'town', 'village', 'hamlet', 'municipality'].includes(String(properties.osm_value)) ||
    value.geometry.type !== 'Point' ||
    !Array.isArray(value.geometry.coordinates)
  ) {
    return undefined;
  }
  const name = text(properties.name);
  const longitude = finiteNumber(value.geometry.coordinates[0]);
  const latitude = finiteNumber(value.geometry.coordinates[1]);
  if (
    !name ||
    latitude === undefined ||
    longitude === undefined ||
    !validCoordinates(latitude, longitude)
  ) {
    return undefined;
  }
  const countryCode = text(properties.countrycode, 16)?.toUpperCase();
  return {
    name,
    latitude,
    longitude,
    country: text(properties.country),
    region: text(properties.state) ?? text(properties.county),
    district: text(properties.county),
    countryCode: countryCode && /^[A-Z]{2}$/u.test(countryCode) ? countryCode : undefined,
    attribution: 'openstreetmap',
  };
}

function chooseLocation(
  query: WeatherLocationQuery,
  candidates: WeatherLocation[],
  attribution: WeatherAttribution,
): LocationResolution {
  const matchingCandidates = candidates.filter(
    (candidate) =>
      (!query.countryCode || candidate.countryCode === query.countryCode) &&
      (!query.country || normalize(candidate.country ?? '') === normalize(query.country)) &&
      (!query.region ||
        [candidate.region, candidate.district, candidate.country].some(
          (field) => field !== undefined && normalize(field) === normalize(query.region ?? ''),
        )),
  );
  const unique = [
    ...new Map(
      matchingCandidates.map((candidate) => [
        `${normalize(candidate.name)}:${candidate.latitude.toFixed(4)}:${candidate.longitude.toFixed(4)}`,
        candidate,
      ]),
    ).values(),
  ];
  if (unique.length === 0) {
    return { status: 'not_found', message: 'Населённый пункт не найден. Уточните его название.' };
  }

  const name = normalize(query.name.split(',')[0]);
  const exact = unique.filter((candidate) => normalize(candidate.name) === name);
  const matches = exact.length > 0 ? exact : unique;
  if (exact.length === 1) return { status: 'found', location: exact[0] };
  return { status: 'ambiguous', candidates: matches.slice(0, 5), attribution };
}

function conditionFromWmo(value: unknown): { condition?: string; conditionCode?: string } {
  const code = finiteNumber(value);
  if (code === undefined || !Number.isInteger(code)) return {};
  return { condition: WMO_CONDITIONS[code], conditionCode: `WMO ${code}` };
}

function conditionFromMet(value: unknown): { condition?: string; conditionCode?: string } {
  const code = text(value, 80);
  if (!code || !/^[a-z_]+$/u.test(code)) return {};
  const base = code.replace(/_(?:day|night|polartwilight)$/u, '');
  const simple: Record<string, string> = {
    clearsky: 'ясно',
    fair: 'преимущественно ясно',
    partlycloudy: 'переменная облачность',
    cloudy: 'пасмурно',
    fog: 'туман',
  };
  if (simple[base]) return { condition: simple[base], conditionCode: code };
  const match = /^(light|heavy)?s?(rain|sleet|snow)(showers)?(andthunder)?$/u.exec(base);
  if (!match) return { conditionCode: code };
  const intensity = match[1] === 'light' ? 'слабый ' : match[1] === 'heavy' ? 'сильный ' : '';
  const kind = match[2] === 'rain' ? 'дождь' : match[2] === 'sleet' ? 'мокрый снег' : 'снег';
  return {
    condition: `${intensity}${kind}${match[3] ? ', кратковременные осадки' : ''}${match[4] ? ', гроза' : ''}`,
    conditionCode: code,
  };
}

function parseOpenMeteoSeries(value: unknown, fetchedAt: string): WeatherSeries {
  if (
    !isRecord(value) ||
    !isRecord(value.current) ||
    !isRecord(value.hourly) ||
    !isRecord(value.current_units) ||
    !isRecord(value.hourly_units)
  ) {
    throw new Error('Open-Meteo returned invalid weather data');
  }
  for (const units of [value.current_units, value.hourly_units]) {
    if (
      units.time !== 'unixtime' ||
      units.temperature_2m !== '°C' ||
      units.relative_humidity_2m !== '%' ||
      units.precipitation !== 'mm' ||
      units.wind_speed_10m !== 'm/s'
    ) {
      throw new Error('Open-Meteo returned unexpected weather units');
    }
  }
  if (
    value.current_units.apparent_temperature !== '°C' ||
    value.hourly_units.precipitation_probability !== '%'
  ) {
    throw new Error('Open-Meteo returned unexpected weather units');
  }
  const currentTime = unixTimestamp(value.current.time);
  const currentTemperature = finiteNumber(value.current.temperature_2m);
  const times = value.hourly.time;
  const temperatures = value.hourly.temperature_2m;
  if (
    !currentTime ||
    currentTemperature === undefined ||
    !Array.isArray(times) ||
    !Array.isArray(temperatures)
  ) {
    throw new Error('Open-Meteo returned incomplete weather data');
  }
  const hourly = value.hourly;
  const hourlyValue = (key: string, index: number): unknown =>
    Array.isArray(hourly[key]) ? hourly[key][index] : undefined;
  const forecast = times.flatMap((time, index): WeatherPoint[] => {
    const timeUtc = unixTimestamp(time);
    const temperatureC = finiteNumber(temperatures[index]);
    if (!timeUtc || temperatureC === undefined) return [];
    return [
      {
        timeUtc,
        temperatureC,
        humidityPercent: percent(hourlyValue('relative_humidity_2m', index)),
        windSpeedMs: nonNegative(hourlyValue('wind_speed_10m', index)),
        ...conditionFromWmo(hourlyValue('weather_code', index)),
        precipitationMm: nonNegative(hourlyValue('precipitation', index)),
        precipitationPeriod: 'за предыдущий час',
        precipitationProbabilityPercent: percent(hourlyValue('precipitation_probability', index)),
      },
    ];
  });
  if (forecast.length === 0) throw new Error('Open-Meteo returned no forecast');
  const interval = finiteNumber(value.current.interval);
  return {
    source: 'open_meteo',
    fetchedAt,
    current: {
      timeUtc: currentTime,
      temperatureC: currentTemperature,
      apparentTemperatureC: finiteNumber(value.current.apparent_temperature),
      humidityPercent: percent(value.current.relative_humidity_2m),
      windSpeedMs: nonNegative(value.current.wind_speed_10m),
      ...conditionFromWmo(value.current.weather_code),
      precipitationMm: nonNegative(value.current.precipitation),
      precipitationPeriod:
        interval !== undefined && interval > 0 ? `за предыдущие ${interval / 60} мин` : undefined,
    },
    forecast,
  };
}

function parseMetSeries(value: unknown, fetchedAt: string): WeatherSeries {
  if (
    !isRecord(value) ||
    !isRecord(value.properties) ||
    !Array.isArray(value.properties.timeseries)
  ) {
    throw new Error('MET Norway returned invalid weather data');
  }
  const meta = isRecord(value.properties.meta) ? value.properties.meta : {};
  const units = isRecord(meta.units) ? meta.units : {};
  if (
    units.air_temperature !== 'celsius' ||
    units.relative_humidity !== '%' ||
    units.wind_speed !== 'm/s' ||
    units.precipitation_amount !== 'mm'
  ) {
    throw new Error('MET Norway returned unexpected weather units');
  }
  const forecast = value.properties.timeseries.flatMap((item): WeatherPoint[] => {
    if (!isRecord(item) || !isRecord(item.data) || !isRecord(item.data.instant)) return [];
    const instant = item.data.instant;
    if (!isRecord(instant.details)) return [];
    const timeUtc = utcTimestamp(item.time);
    const temperatureC = finiteNumber(instant.details.air_temperature);
    if (!timeUtc || temperatureC === undefined) return [];
    const period = isRecord(item.data.next_1_hours)
      ? item.data.next_1_hours
      : isRecord(item.data.next_6_hours)
        ? item.data.next_6_hours
        : undefined;
    const periodHours = period ? (period === item.data.next_1_hours ? 1 : 6) : undefined;
    const summary = period && isRecord(period.summary) ? period.summary : {};
    const details = period && isRecord(period.details) ? period.details : {};
    return [
      {
        timeUtc,
        temperatureC,
        humidityPercent: percent(instant.details.relative_humidity),
        windSpeedMs: nonNegative(instant.details.wind_speed),
        ...conditionFromMet(summary.symbol_code),
        conditionPeriod: periodHours ? `на следующие ${periodHours} ч` : undefined,
        precipitationMm: nonNegative(details.precipitation_amount),
        precipitationPeriod: periodHours ? `за следующие ${periodHours} ч` : undefined,
      },
    ];
  });
  if (forecast.length === 0) throw new Error('MET Norway returned no forecast');
  return {
    source: 'met_norway',
    fetchedAt,
    issuedAt: utcTimestamp(meta.updated_at),
    forecast,
  };
}

async function requestJson(
  url: string,
  options: Parameters<WeatherHttpRequest>[1],
): Promise<WeatherHttpResponse> {
  const response = await axios.get<unknown>(url, {
    params: options.params,
    timeout: TIMEOUT_MS,
    maxContentLength: MAX_RESPONSE_BYTES,
    maxRedirects: 0,
    responseType: 'json',
    transitional: { silentJSONParsing: false },
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, ...options.headers },
    validateStatus: (status) =>
      (status >= 200 && status < 300) || (options.allowNotModified === true && status === 304),
  });
  return {
    data: response.data,
    status: response.status,
    expires: text(response.headers.expires, 100),
    lastModified: text(response.headers['last-modified'], 100),
  };
}

function sourceError(source: string, error: unknown): void {
  logger.warn(
    {
      source,
      errorName: error instanceof Error ? error.name : 'UnknownError',
      ...(axios.isAxiosError(error) && error.response ? { status: error.response.status } : {}),
    },
    'Weather service request failed',
  );
}

function retryAfter(error: unknown, now: number): number {
  let until = now + 5 * 60_000;
  if (axios.isAxiosError(error) && error.response?.status === 429) {
    const header: unknown = error.response.headers['retry-after'];
    if (typeof header === 'string') {
      const seconds = Number(header);
      const fromHeader = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(header);
      if (Number.isFinite(fromHeader)) until = Math.max(until, fromHeader);
    }
  }
  return until;
}

/**
 * Находит населённые пункты и получает погодные данные с независимым резервным источником.
 */
export class WeatherService {
  private readonly geoCache: RequestCache<WeatherLocation[]>;
  private readonly openMeteoCache: RequestCache<WeatherSeries>;
  private readonly metCache: RequestCache<MetCacheValue>;
  private readonly photonQueue = new PQueue({ concurrency: 1, interval: 1000, intervalCap: 1 });
  private readonly metQueue = new PQueue({ concurrency: 4, interval: 1000, intervalCap: 5 });
  private openMeteoRetryAfter = 0;
  private photonRetryAfter = 0;
  private metRetryAfter = 0;

  constructor(
    private readonly request: WeatherHttpRequest = requestJson,
    private readonly now: () => number = Date.now,
  ) {
    this.geoCache = new RequestCache(now);
    this.openMeteoCache = new RequestCache(now);
    this.metCache = new RequestCache(now, true);
  }

  async resolveLocation(query: WeatherLocationQuery): Promise<LocationResolution> {
    let successfulSources = 0;
    for (const source of ['open_meteo', 'photon'] as const) {
      try {
        const candidates = await this.geocode(source, query);
        successfulSources += 1;
        if (candidates.length > 0) {
          const resolution = chooseLocation(
            query,
            candidates,
            source === 'open_meteo' ? 'geonames' : 'openstreetmap',
          );
          if (resolution.status !== 'not_found') return resolution;
        }
      } catch (error) {
        sourceError(source, error);
      }
    }
    if (successfulSources === 0) throw new GeocodingUnavailableError();
    return {
      status: 'not_found',
      message:
        successfulSources === 1
          ? 'В доступном сервисе населённый пункт не найден; второй сервис недоступен. Уточните название.'
          : 'Населённый пункт не найден. Уточните его название.',
    };
  }

  async getWeather(location: WeatherLocation, forecastDays: number): Promise<WeatherResult> {
    for (const source of ['open_meteo', 'met_norway'] as const) {
      try {
        const series =
          source === 'open_meteo'
            ? await this.getOpenMeteo(location)
            : await this.getMetNorway(location);
        const now = this.now();
        const initialForecast = series.forecast[0];
        const current =
          series.current ??
          (initialForecast
            ? series.forecast.reduce(
                (closest, point) =>
                  Math.abs(Date.parse(point.timeUtc) - now) <
                  Math.abs(Date.parse(closest.timeUtc) - now)
                    ? point
                    : closest,
                initialForecast,
              )
            : undefined);
        if (!current) throw new Error('Weather provider returned no forecast');
        if (Math.abs(Date.parse(current.timeUtc) - now) > 2 * 60 * 60_000) {
          throw new Error('Weather provider returned an outdated current forecast');
        }
        const end = now + forecastDays * 24 * 60 * 60_000;
        const forecast = series.forecast
          .filter((point) => {
            const time = Date.parse(point.timeUtc);
            return (
              time > now &&
              time <= end &&
              (time <= now + 24 * 60 * 60_000 || new Date(time).getUTCHours() % 6 === 0)
            );
          })
          .toSorted((a, b) => Date.parse(a.timeUtc) - Date.parse(b.timeUtc));
        const lastForecast = forecast.at(-1);
        if (!lastForecast || Date.parse(lastForecast.timeUtc) < end - 6 * 60 * 60_000) {
          throw new Error('Weather provider returned an incomplete forecast');
        }
        let previousTime = now;
        for (const point of forecast) {
          const time = Date.parse(point.timeUtc);
          const maxGap = time <= now + 24 * 60 * 60_000 ? 90 * 60_000 : 7 * 60 * 60_000;
          if (time <= previousTime || time - previousTime > maxGap) {
            throw new Error('Weather provider returned gaps in the forecast');
          }
          previousTime = time;
        }
        return {
          source,
          fetchedAt: series.fetchedAt,
          issuedAt: series.issuedAt,
          current,
          forecast,
        };
      } catch (error) {
        sourceError(source, error);
      }
    }
    throw new WeatherUnavailableError();
  }

  private async geocode(
    source: 'open_meteo' | 'photon',
    query: WeatherLocationQuery,
  ): Promise<WeatherLocation[]> {
    const key = `${source}:${normalize(query.name)}:${normalize(query.region ?? '')}:${query.countryCode ?? ''}:${normalize(query.country ?? '')}`;
    return this.geoCache.get(key, async () => {
      const qualifier = query.region ?? query.country;
      const name = qualifier ? `${query.name}, ${qualifier}` : query.name;
      let response: WeatherHttpResponse;
      if (source === 'open_meteo') {
        response = await this.requestOpenMeteo(OPEN_METEO_GEOCODING_URL, {
          params: {
            name,
            count: 10,
            language: /\p{Script=Cyrillic}/u.test(query.name) ? 'ru' : 'en',
            format: 'json',
            ...(query.countryCode ? { countryCode: query.countryCode } : {}),
          },
        });
        if (
          !isRecord(response.data) ||
          response.data.error === true ||
          (response.data.results !== undefined && !Array.isArray(response.data.results))
        ) {
          throw new Error('Open-Meteo returned invalid location data');
        }
        const results = Array.isArray(response.data.results) ? response.data.results : [];
        const locations = results
          .map(parseOpenMeteoLocation)
          .filter((item): item is WeatherLocation => item !== undefined);
        if (results.length > 0 && locations.length === 0) {
          throw new Error('Open-Meteo returned invalid locations');
        }
        return {
          value: locations,
          expiresAt: this.now() + GEOCODING_CACHE_MS,
        };
      }
      if (this.photonRetryAfter > this.now() || this.photonQueue.size >= MAX_QUEUE_SIZE) {
        throw new Error('Photon is temporarily unavailable');
      }
      response = await this.photonQueue.add(
        async () => {
          if (this.photonRetryAfter > this.now()) {
            throw new Error('Photon is temporarily unavailable');
          }
          try {
            return await this.request(PHOTON_GEOCODING_URL, {
              params: {
                q: name,
                limit: 10,
                ...(query.countryCode ? { countrycode: query.countryCode } : {}),
              },
            });
          } catch (error) {
            if (axios.isAxiosError(error) && error.response?.status === 429) {
              this.photonRetryAfter = retryAfter(error, this.now());
            }
            throw error;
          }
        },
        { throwOnTimeout: true },
      );
      if (!isRecord(response.data) || !Array.isArray(response.data.features)) {
        throw new Error('Photon returned invalid location data');
      }
      return {
        value: response.data.features
          .map(parsePhotonLocation)
          .filter((item): item is WeatherLocation => item !== undefined),
        expiresAt: this.now() + GEOCODING_CACHE_MS,
      };
    });
  }

  private async getOpenMeteo(location: WeatherLocation): Promise<WeatherSeries> {
    const key = `${location.latitude.toFixed(4)}:${location.longitude.toFixed(4)}`;
    return this.openMeteoCache.get(key, async () => {
      const response = await this.requestOpenMeteo(OPEN_METEO_FORECAST_URL, {
        params: {
          latitude: location.latitude,
          longitude: location.longitude,
          current:
            'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m',
          hourly:
            'temperature_2m,relative_humidity_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m',
          forecast_days: 8,
          wind_speed_unit: 'ms',
          timezone: 'UTC',
          timeformat: 'unixtime',
        },
      });
      return {
        value: parseOpenMeteoSeries(response.data, new Date(this.now()).toISOString()),
        expiresAt: this.now() + OPEN_METEO_CACHE_MS,
      };
    });
  }

  private async getMetNorway(location: WeatherLocation): Promise<WeatherSeries> {
    const latitude = location.latitude.toFixed(4);
    const longitude = location.longitude.toFixed(4);
    const cached = await this.metCache.get(`${latitude}:${longitude}`, async (previous) => {
      if (this.metRetryAfter > this.now() || this.metQueue.size >= MAX_QUEUE_SIZE) {
        throw new Error('MET Norway is temporarily unavailable');
      }
      const response = await this.metQueue.add(
        async () => {
          if (this.metRetryAfter > this.now()) {
            throw new Error('MET Norway is temporarily unavailable');
          }
          try {
            return await this.request(MET_FORECAST_URL, {
              params: { lat: latitude, lon: longitude },
              headers: previous?.lastModified
                ? { 'If-Modified-Since': previous.lastModified }
                : undefined,
              allowNotModified: true,
            });
          } catch (error) {
            if (axios.isAxiosError(error) && error.response?.status === 429) {
              this.metRetryAfter = retryAfter(error, this.now());
            }
            throw error;
          }
        },
        { throwOnTimeout: true },
      );
      const expires = response.expires ? Date.parse(response.expires) : NaN;
      const expiresAt = Math.max(
        this.now() + MET_MIN_CACHE_MS,
        Number.isFinite(expires) ? expires : 0,
      );
      if (response.status === 304) {
        if (!previous) throw new Error('MET Norway returned 304 without cached data');
        return { value: previous, expiresAt };
      }
      try {
        return {
          value: {
            status: 'valid' as const,
            series: parseMetSeries(response.data, new Date(this.now()).toISOString()),
            lastModified: response.lastModified,
          },
          expiresAt,
        };
      } catch (error) {
        sourceError('met_norway_invalid_response', error);
        return {
          value: { status: 'invalid' as const, lastModified: response.lastModified },
          expiresAt,
        };
      }
    });
    if (cached.status === 'invalid') throw new Error('MET Norway returned invalid weather data');
    return cached.series;
  }

  private async requestOpenMeteo(
    url: string,
    options: Parameters<WeatherHttpRequest>[1],
  ): Promise<WeatherHttpResponse> {
    if (this.openMeteoRetryAfter > this.now()) {
      throw new Error('Open-Meteo is temporarily unavailable');
    }
    try {
      return await this.request(url, options);
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 429) {
        this.openMeteoRetryAfter = retryAfter(error, this.now());
      }
      throw error;
    }
  }
}

export function formatWeatherAttributions(attributions: ReadonlySet<WeatherAttribution>): string {
  const sources: string[] = [];
  if (attributions.has('open_meteo')) sources.push('Open-Meteo.com: https://open-meteo.com/');
  if (attributions.has('met_norway')) sources.push('MET Norway: https://api.met.no/');
  if (attributions.has('geonames')) sources.push('GeoNames: https://www.geonames.org/');
  if (attributions.has('openstreetmap')) {
    sources.push('© OpenStreetMap contributors (ODbL): https://www.openstreetmap.org/copyright');
  }
  const ccBy =
    attributions.has('open_meteo') ||
    attributions.has('met_norway') ||
    attributions.has('geonames');
  return sources.length > 0
    ? `\n\nИсточники: ${sources.join('; ')}. Данные преобразованы.${ccBy ? ' CC BY: https://creativecommons.org/licenses/by/4.0/' : ''}`
    : '';
}

const weatherService = new WeatherService();
export default weatherService;
