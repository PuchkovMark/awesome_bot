import assert from 'node:assert/strict';
import test from 'node:test';
import type { AIMessage, AIProvider, AIResponse } from '../src/services/ai/AIProvider.js';
import { AsyncTtlCache } from '../src/services/realWorld/asyncTtlCache.js';
import { detectContextRelevance } from '../src/services/realWorld/contextRelevance.js';
import { getDateTimeContext } from '../src/services/realWorld/dateTimeProvider.js';
import { HolidayProvider } from '../src/services/realWorld/holidayProvider.js';
import { HoroscopeProvider } from '../src/services/realWorld/horoscopeProvider.js';
import { OpenMeteoProvider } from '../src/services/realWorld/openMeteoProvider.js';
import { RealWorldContextService } from '../src/services/realWorld/realWorldContextService.js';
import type {
  ContextFact,
  ProviderRequest,
  RealWorldContextProvider,
  WeatherContextData,
} from '../src/services/realWorld/types.js';
import type { RealWorldLocation } from '../src/services/settings/settingsService.js';

const now = new Date('2026-03-28T12:00:00.000Z');
const moscow: RealWorldLocation = {
  name: 'Москва',
  latitude: 55.75204,
  longitude: 37.61781,
  countryCode: 'RU',
  region: 'Москва',
  timeZone: 'Europe/Moscow',
};

function providerRequest(
  location: RealWorldLocation,
  weatherPeriod: ProviderRequest['weatherPeriod'] = 'today',
): ProviderRequest {
  return {
    text: 'Пенёк, какая погода?',
    previousMessages: [],
    isChat: false,
    now,
    timeZone: 'Europe/Moscow',
    timeZoneSource: 'location',
    location,
    weatherPeriod,
    needsCalendar: false,
  };
}

/**
 * Подменяет AI-провайдера в тестах и сохраняет отправленные сообщения для проверок.
 */
class MockAIProvider implements AIProvider {
  readonly name = 'mock';
  calls = 0;
  lastMessages: AIMessage[] = [];

  async send(messages: AIMessage[]): Promise<AIResponse> {
    this.calls += 1;
    this.lastMessages = messages;
    return { content: 'Развлекательный прогноз.', inputTokens: 10, outputTokens: 20 };
  }
}

test('date and time context respects IANA timezone and date boundaries', () => {
  const context = getDateTimeContext(new Date('2026-03-28T22:30:00.000Z'), 'Asia/Tokyo', 'user');

  assert.equal(context.localDate, '2026-03-29');
  assert.equal(context.localTime, '07:30:00');
  assert.equal(context.dayOfWeek, 'воскресенье');
  assert.equal(context.tomorrow, '2026-03-30');
  assert.equal(context.timeZone, 'Asia/Tokyo');
  assert.equal(context.timeZoneSource, 'user');
  assert.equal(context.utcOffset, 'UTC+09:00');
});

test('date and time context handles daylight-saving offsets', () => {
  const before = getDateTimeContext(new Date('2026-03-29T00:30:00.000Z'), 'Europe/Berlin');
  const after = getDateTimeContext(new Date('2026-03-29T01:30:00.000Z'), 'Europe/Berlin');

  assert.equal(before.utcOffset, 'UTC+01:00');
  assert.equal(after.utcOffset, 'UTC+02:00');
});

test('context relevance recognizes weather, dates, places, and natural horoscope forms', () => {
  assert.deepEqual(
    detectContextRelevance('Пенёк, какая погода в Москве?').weatherPeriod,
    'current',
  );
  assert.equal(detectContextRelevance('Пенёк, какая погода в Москве?').explicitLocation, 'Москве');
  assert.equal(detectContextRelevance('Будет ли завтра дождь?').weatherPeriod, 'tomorrow');
  assert.equal(
    detectContextRelevance('Пенёк, что будет с погодой на выходных?').weatherPeriod,
    'weekend',
  );
  assert.equal(
    detectContextRelevance('Пенёк, будет ли дождь послезавтра?').weatherPeriod,
    'after_tomorrow',
  );
  assert.equal(detectContextRelevance('Пенёк, прогноз на ближайшую неделю').weatherPeriod, 'week');
  assert.equal(detectContextRelevance('Какой сегодня праздник?').needsCalendar, true);
  assert.equal(detectContextRelevance('Пенёк, какая сейчас дата и время?').explicitDateTime, true);
  assert.equal(detectContextRelevance('Пенёк, который час в Москве?').explicitLocation, 'Москве');
  assert.equal(detectContextRelevance('Какой сегодня день недели?').explicitDateTime, true);
  assert.equal(detectContextRelevance('Какой праздник в России?').explicitCountryCode, 'RU');

  const horoscope = detectContextRelevance('Что сегодня ждёт Скорпионов?').horoscope;
  assert.deepEqual(horoscope, { sign: 'Скорпион', period: 'today', category: 'general' });
  assert.deepEqual(detectContextRelevance('Гороскоп на завтра для Овна').horoscope, {
    sign: 'Овен',
    period: 'tomorrow',
    category: 'general',
  });
  assert.deepEqual(detectContextRelevance('Любовный гороскоп для Тельца').horoscope, {
    sign: 'Телец',
    period: 'today',
    category: 'love',
  });
  assert.deepEqual(
    detectContextRelevance('Что звёзды обещают Водолеям на этой неделе?').horoscope,
    { sign: 'Водолей', period: 'week', category: 'general' },
  );
  assert.equal(detectContextRelevance('Сегодня я видел Скорпиона').horoscope, undefined);
});

test('all twelve zodiac signs are recognized in horoscope requests', () => {
  const examples = [
    ['Овен', 'Овнов'],
    ['Телец', 'Тельцов'],
    ['Близнецы', 'Близнецов'],
    ['Рак', 'Раков'],
    ['Лев', 'Львов'],
    ['Дева', 'Дев'],
    ['Весы', 'Весов'],
    ['Скорпион', 'Скорпионов'],
    ['Стрелец', 'Стрельцов'],
    ['Козерог', 'Козерогов'],
    ['Водолей', 'Водолеев'],
    ['Рыбы', 'Рыб'],
  ] as const;

  for (const [sign, form] of examples) {
    assert.equal(detectContextRelevance(`Гороскоп для ${form}`).horoscope?.sign, sign);
  }
});

test('async TTL cache coalesces requests, expires values, and cools down failures', async () => {
  let time = 0;
  let calls = 0;
  const cache = new AsyncTtlCache<number>(5, () => time);
  const load = async () => {
    calls += 1;
    await Promise.resolve();
    return calls;
  };

  const results = await Promise.all([cache.get('same', 100, load), cache.get('same', 100, load)]);
  assert.deepEqual(results, [1, 1]);
  assert.equal(calls, 1);
  assert.equal(await cache.get('same', 100, load), 1);
  time = 101;
  assert.equal(await cache.get('same', 100, load), 2);

  let failedCalls = 0;
  const failingLoad = async () => {
    failedCalls += 1;
    throw new Error('temporary');
  };
  await assert.rejects(cache.get('failure', 100, failingLoad, 50), /temporary/u);
  await assert.rejects(cache.get('failure', 100, failingLoad, 50), /temporary/u);
  assert.equal(failedCalls, 1);
  time += 51;
  await assert.rejects(cache.get('failure', 100, failingLoad, 50), /temporary/u);
  assert.equal(failedCalls, 2);
});

test('Open-Meteo resolves inflected Russian city names to the dominant exact match', async () => {
  const calls: string[] = [];
  const provider = new OpenMeteoProvider(async (_url, params) => {
    const query = String(params.name);
    calls.push(query);
    if (query !== 'Москва') return { results: [] };
    return {
      results: [
        {
          name: 'Москва',
          latitude: 55.75204,
          longitude: 37.61781,
          country_code: 'RU',
          admin1: 'Москва',
          timezone: 'Europe/Moscow',
          population: 10_381_222,
        },
        {
          name: 'Москва',
          latitude: 46.73239,
          longitude: -117.00017,
          country_code: 'US',
          admin1: 'Айдахо',
          timezone: 'America/Los_Angeles',
          population: 25_060,
        },
      ],
    };
  });

  const result = await provider.resolveLocation('Москве');

  assert.equal(result.location?.countryCode, 'RU');
  assert.equal(result.location?.timeZone, 'Europe/Moscow');
  assert.ok(calls.includes('Москва'));
});

test('Open-Meteo asks to disambiguate equally likely cities', async () => {
  const provider = new OpenMeteoProvider(async () => ({
    results: [
      {
        name: 'Springfield',
        latitude: 39.8,
        longitude: -89.6,
        country_code: 'US',
        admin1: 'Illinois',
        timezone: 'America/Chicago',
        population: 100_000,
      },
      {
        name: 'Springfield',
        latitude: 42.1,
        longitude: -72.6,
        country_code: 'US',
        admin1: 'Massachusetts',
        timezone: 'America/New_York',
        population: 100_000,
      },
    ],
  }));

  const result = await provider.resolveLocation('Springfield');

  assert.equal(result.location, undefined);
  assert.equal(result.ambiguous?.length, 2);
});

test('Open-Meteo normalizes current weather and forecast without inventing missing fields', async () => {
  const calls: Array<{ url: string; params: Record<string, string | number> }> = [];
  const provider = new OpenMeteoProvider(async (url, params) => {
    calls.push({ url, params });
    if ('current' in params) {
      return {
        current: {
          temperature_2m: 8,
          apparent_temperature: 5,
          relative_humidity_2m: 70,
          weather_code: 3,
          wind_speed_10m: 12,
          wind_direction_10m: 90,
          pressure_msl: 1014,
        },
      };
    }
    return {
      daily: {
        time: ['2026-03-28', '2026-03-29', '2026-03-30'],
        weather_code: [3, 61, 0],
        temperature_2m_min: [6, 2, 1],
        temperature_2m_max: [10, 7, 9],
        precipitation_probability_max: [10, 80, 0],
        rain_sum: [0, 3, 0],
        snowfall_sum: [0, 0, 0],
        wind_speed_10m_max: [12, 20, 8],
        wind_direction_10m_dominant: [90, 180, 0],
      },
    };
  });

  const fact = await provider.getContext(providerRequest(moscow));
  assert.ok(fact);
  const data = fact.data as WeatherContextData;
  assert.deepEqual(data.current, {
    temperatureC: 8,
    feelsLikeC: 5,
    condition: 'пасмурно',
    windSpeedKmh: 12,
    windDirection: 'В',
    humidityPercent: 70,
    pressureHpa: 1014,
    precipitationMm: undefined,
  });
  assert.equal(data.days?.[0].minTemperatureC, 6);
  assert.equal(data.days?.[0].maxTemperatureC, 10);
  assert.equal(data.days?.[0].precipitationProbabilityPercent, 10);
  assert.equal(data.currentRetrievedAt, fact.retrievedAt);

  const afterTomorrow = await provider.getContext(providerRequest(moscow, 'after_tomorrow'));
  assert.equal((afterTomorrow?.data as WeatherContextData).days?.[0].date, '2026-03-30');

  const weekend = await provider.getContext(providerRequest(moscow, 'weekend'));
  assert.deepEqual(
    (weekend?.data as WeatherContextData).days?.map(({ date }) => date),
    ['2026-03-28', '2026-03-29'],
  );
  assert.equal(calls.length, 2);
  assert.ok(calls.every(({ params }) => params.timezone === 'Europe/Moscow'));
});

test('holiday provider limits results to the requested horizon and marks regional scope', async () => {
  const provider = new HolidayProvider(async (url) => {
    const year = Number(url.match(/PublicHolidays\/(\d+)/u)?.[1]);
    return [
      {
        date: `${year}-04-01`,
        name: 'National holiday',
        localName: 'Праздник',
        countryCode: 'RU',
        global: true,
        counties: null,
        types: ['Public'],
      },
      {
        date: `${year}-12-31`,
        name: 'Regional holiday',
        localName: 'Региональный праздник',
        countryCode: 'RU',
        global: false,
        counties: ['RU-MOW'],
        types: ['Public'],
      },
      {
        date: `${year}-01-01`,
        name: 'Other country',
        localName: 'Чужой праздник',
        countryCode: 'US',
        global: true,
        counties: null,
        types: ['Public'],
      },
    ];
  });

  const fact = await provider.getContext({
    ...providerRequest(moscow),
    text: 'Какой праздник скоро?',
    needsCalendar: true,
    calendarDaysAhead: 30,
  });

  assert.ok(fact);
  assert.equal(fact.source, 'Nager.Date');
  assert.equal(fact.data.countryCode, 'RU');
  assert.equal(fact.data.regionalHolidaysNeedCountyMatch, true);
  assert.ok(Array.isArray(fact.data.holidays));
  assert.ok(fact.retrievedAt);
  assert.ok(fact.expiresAt);
});

test('horoscope provider caches generated entertainment by date, sign, period, and category', async () => {
  const provider = new HoroscopeProvider();
  const ai = new MockAIProvider();
  const context = getDateTimeContext(now, 'Europe/Moscow', 'location');
  const request = { sign: 'Весы', period: 'today', category: 'love' } as const;

  const first = await provider.generate(request, ai, 'Пенёк', 'Будь дружелюбным.', context);
  const second = await provider.generate(request, ai, 'Пенёк', 'Будь дружелюбным.', context);

  assert.equal(first.response.content, 'Развлекательный прогноз.');
  assert.equal(second.response.content, first.response.content);
  assert.equal(ai.calls, 1);
  assert.ok(ai.lastMessages[0].content.includes('не научно'));
  const fact = provider.createFact(request, first, context);
  assert.equal(fact.data.date, context.localDate);
  assert.equal(fact.retrievedAt, first.generatedAt);
});

test('context service never uses a participant personal location in group chats', async () => {
  const weatherProvider = new OpenMeteoProvider(async () => {
    throw new Error('Should not fetch without a group location');
  });
  const service = new RealWorldContextService(weatherProvider);
  const privatePreferences = {
    locationName: 'Privateville',
    locationLatitude: 1,
    locationLongitude: 2,
    locationCountry: 'US',
    locationRegion: 'Private region',
    locationTimeZone: 'America/Los_Angeles',
    timeZone: null,
  };
  const emptyPreferences = {
    locationName: null,
    locationLatitude: null,
    locationLongitude: null,
    locationCountry: null,
    locationRegion: null,
    locationTimeZone: null,
    timeZone: null,
  };

  const prepared = await service.prepare({
    text: 'Пенёк, какая погода?',
    previousMessages: [],
    isChat: true,
    now,
    userPreferences: privatePreferences,
    chatPreferences: emptyPreferences,
  });

  assert.equal(prepared.location, undefined);
  assert.equal(prepared.locationProblem, 'missing');
  assert.equal(prepared.dateTime.timeZone, 'Europe/Moscow');
  assert.equal(prepared.prompt.includes('Privateville'), false);
  assert.equal(prepared.prompt.includes('America/Los_Angeles'), false);
});

test('explicit city time request uses that city timezone instead of saved timezone', async () => {
  const provider = new OpenMeteoProvider(async (_url, params) => {
    if (params.name !== 'Москва') return { results: [] };
    return {
      results: [
        {
          name: 'Москва',
          latitude: 55.75204,
          longitude: 37.61781,
          country_code: 'RU',
          timezone: 'Europe/Moscow',
          population: 10_000_000,
        },
      ],
    };
  });
  const service = new RealWorldContextService(provider);
  const preferences = {
    locationName: null,
    locationLatitude: null,
    locationLongitude: null,
    locationCountry: null,
    locationRegion: null,
    locationTimeZone: null,
    timeZone: 'Asia/Tokyo',
  };

  const prepared = await service.prepare({
    text: 'Пенёк, который час в Москве?',
    previousMessages: [],
    isChat: false,
    now,
    userPreferences: preferences,
    chatPreferences: preferences,
  });

  assert.equal(prepared.dateTime.timeZone, 'Europe/Moscow');
  assert.equal(prepared.dateTime.timeZoneSource, 'location');
  assert.equal(prepared.timeZoneProblem, undefined);
});

test('explicit country holidays override a saved city location', async () => {
  let captured: ProviderRequest | undefined;
  const calendarProvider: RealWorldContextProvider = {
    category: 'calendar',
    async getContext(request): Promise<ContextFact> {
      captured = request;
      return {
        category: 'calendar',
        source: 'test',
        retrievedAt: now.toISOString(),
        data: { countryCode: request.countryCode },
      };
    },
  };
  const service = new RealWorldContextService(
    new OpenMeteoProvider(async () => ({ results: [] })),
    calendarProvider,
  );
  const savedLocationPreferences = {
    locationName: 'New York',
    locationLatitude: 40.7,
    locationLongitude: -74,
    locationCountry: 'US',
    locationRegion: 'New York',
    locationTimeZone: 'America/New_York',
    timeZone: null,
  };

  await service.prepare({
    text: 'Какой праздник сегодня в России?',
    previousMessages: [],
    isChat: false,
    now,
    userPreferences: savedLocationPreferences,
    chatPreferences: savedLocationPreferences,
  });

  assert.equal(captured?.countryCode, 'RU');
  assert.equal(captured?.location, undefined);
});

test('natural-language setting intents preserve user and chat scopes', () => {
  const service = new RealWorldContextService(new OpenMeteoProvider(async () => ({ results: [] })));

  assert.deepEqual(service.parseSettingsIntent('Пенёк, запомни, что я живу в Москве.'), {
    scope: 'user',
    type: 'location',
    query: 'Москве',
  });
  assert.deepEqual(service.parseSettingsIntent('Для этой беседы установи город Кишинёв.'), {
    scope: 'chat',
    type: 'location',
    query: 'Кишинев',
  });
  assert.deepEqual(
    service.parseSettingsIntent('Для этой беседы установи часовой пояс Europe/Chisinau.'),
    { scope: 'chat', type: 'timeZone', query: 'Europe/Chisinau' },
  );
  assert.deepEqual(service.parseSettingsIntent('Измени мой город на Санкт-Петербург.'), {
    scope: 'user',
    type: 'location',
    query: 'Санкт-Петербург',
  });
});
