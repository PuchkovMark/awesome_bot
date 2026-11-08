import axios from 'axios';
import config from '../../config/index.js';
import { AsyncTtlCache } from './asyncTtlCache.js';
import type { ContextFact, ProviderRequest, RealWorldContextProvider } from './types.js';

interface Holiday {
  date: string;
  name: string;
  localName: string;
  countryCode: string;
  global: boolean;
  counties: string[];
  types: string[];
}

interface RetrievedHolidays {
  value: Holiday[];
  retrievedAt: string;
  expiresAt: string;
}

type JsonGetter = (url: string) => Promise<unknown>;

async function axiosGet(url: string): Promise<unknown> {
  const response = await axios.get<unknown>(url, {
    timeout: 12_000,
    maxContentLength: 2 * 1024 * 1024,
  });
  return response.data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function localDate(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (name: Intl.DateTimeFormatPartTypes) =>
    parts.find((value) => value.type === name)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function parseHoliday(value: unknown, countryCode: string): Holiday | undefined {
  if (!isRecord(value)) return undefined;
  const date = value.date;
  const name = value.name;
  const localName = value.localName;
  const holidayCountry = value.countryCode;
  if (
    typeof date !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(date) ||
    typeof name !== 'string' ||
    typeof localName !== 'string' ||
    holidayCountry !== countryCode
  ) {
    return undefined;
  }
  const counties = Array.isArray(value.counties)
    ? value.counties.filter((county): county is string => typeof county === 'string')
    : [];
  const types = Array.isArray(value.types)
    ? value.types.filter((type): type is string => typeof type === 'string')
    : [];
  return {
    date,
    name,
    localName,
    countryCode,
    global: value.global === true,
    counties,
    types,
  };
}

/**
 * Получает и нормализует публичные праздники по стране и дате, используя кэш ответов провайдера.
 */
export class HolidayProvider implements RealWorldContextProvider {
  readonly category = 'calendar' as const;
  private readonly cache = new AsyncTtlCache<RetrievedHolidays>(400);

  constructor(private readonly getJson: JsonGetter = axiosGet) {}

  async getContext(request: ProviderRequest): Promise<ContextFact | undefined> {
    if (!request.needsCalendar) return undefined;
    const countryCode = request.location?.countryCode ?? request.countryCode;
    if (!countryCode || !/^[A-Z]{2}$/iu.test(countryCode)) return undefined;

    const today = localDate(request.now, request.timeZone);
    const daysAhead = Math.min(Math.max(request.calendarDaysAhead ?? 365, 1), 730);
    const lastDate = addDays(today, daysAhead);
    const firstYear = Number(today.slice(0, 4));
    const lastYear = Number(lastDate.slice(0, 4));
    const years = firstYear === lastYear ? [firstYear] : [firstYear, lastYear];
    const holidaySets = await Promise.all(
      years.map((year) => this.getYear(countryCode.toUpperCase(), year)),
    );
    const holidays = holidaySets
      .flatMap(({ value }) => value)
      .filter((holiday) => holiday.date >= today && holiday.date <= lastDate)
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, 12);

    return {
      category: this.category,
      source: 'Nager.Date',
      retrievedAt: holidaySets.map(({ retrievedAt }) => retrievedAt).sort()[0],
      expiresAt: holidaySets.map(({ expiresAt }) => expiresAt).sort()[0],
      data: {
        countryCode: countryCode.toUpperCase(),
        ...(request.location?.region ? { region: request.location.region } : {}),
        today,
        holidays,
        regionalHolidaysNeedCountyMatch: true,
      },
    };
  }

  private getYear(countryCode: string, year: number): Promise<RetrievedHolidays> {
    const key = `${countryCode}:${year}`;
    return this.cache.get(
      key,
      config.REAL_WORLD_HOLIDAY_CACHE_SECONDS * 1000,
      async () => {
        const response = await this.getJson(
          `https://date.nager.at/api/v3/PublicHolidays/${year}/${countryCode}`,
        );
        if (!Array.isArray(response)) {
          throw new Error('Nager.Date вернул некорректный список праздников.');
        }
        const value = response
          .map((holiday) => parseHoliday(holiday, countryCode))
          .filter((holiday): holiday is Holiday => holiday !== undefined);
        const retrievedAt = new Date().toISOString();
        return {
          value,
          retrievedAt,
          expiresAt: new Date(
            Date.parse(retrievedAt) + config.REAL_WORLD_HOLIDAY_CACHE_SECONDS * 1000,
          ).toISOString(),
        };
      },
      60_000,
    );
  }
}
