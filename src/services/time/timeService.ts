import axios from 'axios';
import { logger } from '../../logger/index.js';

export type TimeSource = 'timeapi.io' | 'utctime.app';

export type CurrentTime = {
  source: TimeSource;
  instant: Date;
};

type JsonRequest = (url: string) => Promise<unknown>;

const TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 32 * 1024;
const TIME_API_URL = 'https://timeapi.io/api/Time/current/zone?timeZone=UTC';
const UTC_TIME_URL = 'https://utctime.app/api/now';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseUtcDateTime(value: string): Date {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?(?:Z|\+00:00)$/u.exec(value);
  if (!match) throw new Error('Time provider returned an invalid UTC timestamp');
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime()) || instant.toISOString().slice(0, 19) !== match[1]) {
    throw new Error('Time provider returned an invalid UTC date');
  }
  return instant;
}

function parseTimeApiResponse(value: unknown): Date {
  if (!isRecord(value) || value.timeZone !== 'UTC' || typeof value.dateTime !== 'string') {
    throw new Error('TimeAPI.io returned an invalid response');
  }
  const dateTime = /(?:Z|\+00:00)$/u.test(value.dateTime) ? value.dateTime : `${value.dateTime}Z`;
  return parseUtcDateTime(dateTime);
}

function parseUtcTimeResponse(value: unknown): Date {
  if (!isRecord(value) || typeof value.utc_iso !== 'string') {
    throw new Error('UTCtime.app returned an invalid response');
  }
  return parseUtcDateTime(value.utc_iso);
}

async function requestJson(url: string): Promise<unknown> {
  const response = await axios.get<unknown>(url, {
    timeout: TIMEOUT_MS,
    maxContentLength: MAX_RESPONSE_BYTES,
    maxRedirects: 0,
    responseType: 'json',
    transitional: { silentJSONParsing: false },
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
  });
  return response.data;
}

/**
 * Получает текущее UTC-время от двух независимых внешних сервисов.
 */
export class TimeService {
  constructor(private readonly request: JsonRequest = requestJson) {}

  async getCurrentTime(): Promise<CurrentTime> {
    const sources = [
      { name: 'timeapi.io' as const, url: TIME_API_URL, parse: parseTimeApiResponse },
      { name: 'utctime.app' as const, url: UTC_TIME_URL, parse: parseUtcTimeResponse },
    ];
    const errors: Error[] = [];

    for (const source of sources) {
      try {
        const instant = source.parse(await this.request(source.url));
        return { source: source.name, instant };
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
        logger.warn(
          {
            source: source.name,
            errorName: error instanceof Error ? error.name : 'UnknownError',
          },
          'Time provider failed',
        );
      }
    }

    throw new AggregateError(errors, 'All time providers failed');
  }
}

const timeService = new TimeService();
export default timeService;
