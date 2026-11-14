import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocationTool } from '../src/services/ai/tools/locationTool.js';
import { createWeatherTool } from '../src/services/ai/tools/weatherTool.js';
import type { LocationScope, LocationSummary } from '../src/services/settings/locationService.js';
import type {
  WeatherLocation,
  WeatherLocationQuery,
  WeatherResult,
} from '../src/services/weather/weatherService.js';

const emptySettings = {
  locationName: null,
  locationLatitude: null,
  locationLongitude: null,
  locationCountry: null,
  locationRegion: null,
  locationTimeZone: null,
  timeZone: null,
};

const defaultSummary: LocationSummary = {
  city: 'Москва',
  timeZone: 'Europe/Moscow',
  cityConfigured: false,
  timeZoneConfigured: false,
  settings: emptySettings,
};

const allowed = async () => ({ allowed: true as const });

function locationTool(options: { canManage?: boolean } = {}) {
  return createLocationTool({
    scope: 'chat',
    conversationId: '2000000005',
    senderId: '1',
    canManage: async () => options.canManage ?? true,
    checkAccess: allowed,
    operations: locationToolOperations(),
  });
}

test('location tool shows Moscow defaults when settings are empty', async () => {
  const result = JSON.parse(await locationTool().execute({ action: 'show' }));
  assert.equal(result.status, 'result');
  assert.equal(result.city, 'Москва');
  assert.equal(result.time_zone, 'Europe/Moscow');
  assert.equal(result.city_configured, false);
  assert.equal(result.time_zone_configured, false);
  assert.equal(result.settings_configured, false);
});

test('location tool saves a city and reports the derived timezone', async () => {
  let changed: { locationName?: string | null } | undefined;
  const tool = createLocationTool({
    scope: 'chat',
    conversationId: '2000000005',
    senderId: '1',
    canManage: async () => true,
    checkAccess: allowed,
    operations: locationToolOperations(),
    onChanged: (settings) => {
      changed = settings;
    },
  });
  const result = JSON.parse(await tool.execute({ action: 'set_city', city: 'Казань' }));
  assert.equal(result.status, 'result');
  assert.equal(result.location.name, 'Казань');
  assert.equal(result.city, 'Казань');
  assert.equal(result.time_zone, 'Europe/Moscow');
  assert.equal(result.city_configured, true);
  assert.equal(result.time_zone_configured, true);
  assert.equal(changed?.locationName, 'Казань');
});

test('location tool denies chat changes to a non-admin', async () => {
  const result = JSON.parse(
    await locationTool({ canManage: false }).execute({ action: 'set_timezone', time_zone: 'UTC' }),
  );
  assert.equal(result.status, 'not_allowed');
});

test('location tool returns candidate choices for an ambiguous city', async () => {
  const tool = createLocationTool({
    scope: 'chat',
    conversationId: '2000000005',
    senderId: '1',
    canManage: async () => true,
    checkAccess: allowed,
    operations: {
      ...locationToolOperations(),
      setCity: async () => ({
        status: 'ambiguous' as const,
        candidates: [
          {
            name: 'Москва',
            latitude: 55.75,
            longitude: 37.62,
            region: 'Москва',
            country: 'Россия',
          },
          {
            name: 'Москва',
            latitude: 55.75,
            longitude: 37.62,
            region: 'Московская область',
            country: 'Россия',
          },
        ],
        message: 'Найдено несколько населённых пунктов.',
      }),
    },
  });
  const result = JSON.parse(await tool.execute({ action: 'set_city', city: 'Москва' }));
  assert.equal(result.status, 'needs_clarification');
  assert.match(result.message, /Москва/u);
  assert.equal(result.candidates, undefined);
});

const weatherResult: WeatherResult = {
  source: 'open_meteo',
  fetchedAt: '2026-11-13T12:00:00Z',
  current: { timeUtc: '2026-11-13T12:00:00Z', temperatureC: -2 },
  forecast: [{ timeUtc: '2026-11-13T12:00:00Z', temperatureC: -2 }],
};

const voronezhCandidates: WeatherLocation[] = [
  {
    name: 'Воронеж',
    latitude: 51.66833,
    longitude: 39.19204,
    country: 'Россия',
    region: 'Воронежская Область',
    countryCode: 'RU',
    timeZone: 'Europe/Moscow',
  },
  {
    name: 'Воронеж',
    latitude: 51.1946,
    longitude: 82.01049,
    country: 'Россия',
    region: 'Алтайский Край',
    countryCode: 'RU',
    timeZone: 'Asia/Barnaul',
  },
];

test('weather tool uses Moscow and marks defaults when no location is configured', async () => {
  let resolveCalls = 0;
  const tool = createWeatherTool({
    settings: emptySettings,
    scope: 'chat',
    checkAccess: allowed,
    onAttribution: () => {
      // Attribution is irrelevant for this unit test.
    },
    service: {
      resolveLocation: async () => {
        resolveCalls += 1;
        return { status: 'not_found', message: 'not used' };
      },
      getWeather: async () => weatherResult,
    },
  });
  const result = JSON.parse(await tool.execute({}));
  assert.equal(result.status, 'result');
  assert.equal(result.location.name, 'Москва');
  assert.equal(result.location.time_zone, 'Europe/Moscow');
  assert.equal(result.default_used, true);
  assert.equal(result.settings_configured, false);
  assert.match(result.note, /не настроен/u);
  assert.equal(resolveCalls, 0);
});

test('weather tool ignores a city that is not in the current user message', async () => {
  let resolveCalls = 0;
  const tool = createWeatherTool({
    settings: emptySettings,
    scope: 'chat',
    userMessage: 'какая погода на сегодня',
    checkAccess: allowed,
    onAttribution: () => {
      // Attribution is irrelevant for this unit test.
    },
    service: {
      resolveLocation: async () => {
        resolveCalls += 1;
        return { status: 'not_found', message: 'not used' };
      },
      getWeather: async () => weatherResult,
    },
  });
  const result = JSON.parse(await tool.execute({ location: 'Воронеж' }));
  assert.equal(result.status, 'result');
  assert.equal(result.location.name, 'Москва');
  assert.equal(result.default_used, true);
  assert.equal(resolveCalls, 0);
});

test('weather tool asks for clarification as text without raw candidate arrays', async () => {
  const tool = createWeatherTool({
    settings: emptySettings,
    scope: 'chat',
    userMessage: 'какая погода в Воронеже',
    checkAccess: allowed,
    onAttribution: () => {
      // Attribution is irrelevant for this unit test.
    },
    service: {
      resolveLocation: async () => ({
        status: 'ambiguous',
        candidates: voronezhCandidates,
        attribution: 'geonames',
      }),
      getWeather: async () => weatherResult,
    },
  });
  const result = JSON.parse(await tool.execute({ location: 'Воронеж' }));
  assert.equal(result.status, 'needs_clarification');
  assert.match(result.message, /Воронежская Область/u);
  assert.match(result.message, /Алтайский Край/u);
  assert.equal(result.candidates, undefined);
});

function locationToolOperations() {
  return {
    getLocationSummary: async () => defaultSummary,
    setCity: async (_scope: LocationScope, _id: string, query: WeatherLocationQuery) => ({
      status: 'result' as const,
      location: {
        name: query.name,
        latitude: 55.75,
        longitude: 37.62,
        timeZone: 'Europe/Moscow',
      },
      summary: {
        ...defaultSummary,
        city: query.name,
        cityConfigured: true,
        timeZoneConfigured: true,
        settings: {
          ...emptySettings,
          locationName: query.name,
          locationLatitude: 55.75,
          locationLongitude: 37.62,
          locationTimeZone: 'Europe/Moscow',
        },
      },
    }),
    setTimeZone: async (_scope: LocationScope, _id: string, timeZone: string) => ({
      status: 'result' as const,
      summary: {
        ...defaultSummary,
        timeZone,
        timeZoneConfigured: true,
        settings: { ...emptySettings, timeZone },
      },
    }),
    clearLocation: async () => ({ status: 'result' as const, summary: defaultSummary }),
  };
}
