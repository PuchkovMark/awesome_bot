import { logger } from '../../logger/index.js';
import { isValidTimeZone } from '../reminders/reminderDateTime.js';
import weatherService, {
  GeocodingUnavailableError,
  type WeatherLocation,
  type WeatherLocationQuery,
} from '../weather/weatherService.js';
import { DEFAULT_CITY, DEFAULT_TIME_ZONE } from './locationDefaults.js';
import settingsService from './settingsService.js';

export type LocationScope = 'chat' | 'user';

export type LocationSettingsSnapshot = {
  locationName: string | null;
  locationLatitude: number | null;
  locationLongitude: number | null;
  locationCountry: string | null;
  locationRegion: string | null;
  locationTimeZone: string | null;
  timeZone: string | null;
};

export type LocationSummary = {
  city: string;
  timeZone: string;
  cityConfigured: boolean;
  timeZoneConfigured: boolean;
  settings: LocationSettingsSnapshot;
};

export type SetCityResult =
  | { status: 'result'; location: WeatherLocation; summary: LocationSummary }
  | { status: 'ambiguous'; candidates: WeatherLocation[]; message: string }
  | { status: 'not_found'; message: string }
  | { status: 'error'; message: string };

export type SetTimeZoneResult =
  | { status: 'result'; summary: LocationSummary }
  | { status: 'invalid'; message: string }
  | { status: 'error'; message: string };

export type ClearLocationResult =
  { status: 'result'; summary: LocationSummary } | { status: 'error'; message: string };

function snapshotOf(settings: {
  locationName: string | null;
  locationLatitude: number | null;
  locationLongitude: number | null;
  locationCountry: string | null;
  locationRegion: string | null;
  locationTimeZone: string | null;
  timeZone: string | null;
}): LocationSettingsSnapshot {
  return {
    locationName: settings.locationName,
    locationLatitude: settings.locationLatitude,
    locationLongitude: settings.locationLongitude,
    locationCountry: settings.locationCountry,
    locationRegion: settings.locationRegion,
    locationTimeZone: settings.locationTimeZone,
    timeZone: settings.timeZone,
  };
}

async function loadSettings(scope: LocationScope, id: string): Promise<LocationSettingsSnapshot> {
  const settings =
    scope === 'chat'
      ? await settingsService.getChatSettings(id)
      : await settingsService.getUserSettings(id);
  return snapshotOf(settings);
}

function summarize(settings: LocationSettingsSnapshot): LocationSummary {
  const cityConfigured = Boolean(
    settings.locationName?.trim() ||
    settings.locationLatitude !== null ||
    settings.locationLongitude !== null,
  );
  const timeZoneConfigured = Boolean(settings.timeZone || settings.locationTimeZone);
  return {
    city:
      settings.locationName?.trim() || (cityConfigured ? 'Место из настроек' : DEFAULT_CITY.name),
    timeZone: settings.timeZone ?? settings.locationTimeZone ?? DEFAULT_TIME_ZONE,
    cityConfigured,
    timeZoneConfigured,
    settings,
  };
}

export async function getLocationSummary(
  scope: LocationScope,
  id: string,
): Promise<LocationSummary> {
  return summarize(await loadSettings(scope, id));
}

export async function setCity(
  scope: LocationScope,
  id: string,
  query: WeatherLocationQuery,
): Promise<SetCityResult> {
  try {
    const requestedName = query.name.trim().toLocaleLowerCase('ru-RU');
    const useDefaultCity =
      requestedName === DEFAULT_CITY.name.toLocaleLowerCase('ru-RU') &&
      !query.region &&
      !query.country &&
      !query.countryCode;
    let location: WeatherLocation;

    if (useDefaultCity) {
      location = { ...DEFAULT_CITY };
    } else {
      const resolution = await weatherService.resolveLocation(query);
      if (resolution.status === 'not_found') {
        return { status: 'not_found', message: resolution.message };
      }
      if (resolution.status === 'ambiguous') {
        return {
          status: 'ambiguous',
          candidates: resolution.candidates,
          message: 'Найдено несколько населённых пунктов. Уточните регион или страну.',
        };
      }
      location = resolution.location;
    }

    const stored = {
      name: location.name,
      latitude: location.latitude,
      longitude: location.longitude,
      country: location.country ?? location.countryCode,
      countryCode: location.countryCode,
      region: location.region,
      timeZone: location.timeZone,
    };

    if (scope === 'chat') await settingsService.setChatLocation(id, stored);
    else await settingsService.setUserLocation(id, stored);

    return {
      status: 'result',
      location,
      summary: summarize(await loadSettings(scope, id)),
    };
  } catch (error) {
    logger.warn(
      {
        scope,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      },
      'Unable to resolve location for settings',
    );
    return {
      status: 'error',
      message:
        error instanceof GeocodingUnavailableError
          ? 'Не удалось определить город: сервисы поиска населённых пунктов недоступны.'
          : 'Не удалось определить город. Уточните название и повторите попытку.',
    };
  }
}

export async function setTimeZone(
  scope: LocationScope,
  id: string,
  timeZone: string,
): Promise<SetTimeZoneResult> {
  if (!isValidTimeZone(timeZone)) {
    return {
      status: 'invalid',
      message: 'Укажите корректный часовой пояс IANA, например Europe/Moscow.',
    };
  }

  try {
    if (scope === 'chat') await settingsService.setChatTimeZone(id, timeZone);
    else await settingsService.setUserTimeZone(id, timeZone);
    return { status: 'result', summary: summarize(await loadSettings(scope, id)) };
  } catch (error) {
    logger.warn(
      {
        scope,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      },
      'Unable to save location timezone',
    );
    return { status: 'error', message: 'Не удалось сохранить часовой пояс.' };
  }
}

export async function clearLocation(
  scope: LocationScope,
  id: string,
  target: 'city' | 'timezone' | 'all',
): Promise<ClearLocationResult> {
  try {
    if (target === 'city' || target === 'all') {
      if (scope === 'chat') await settingsService.clearChatLocation(id);
      else await settingsService.clearUserLocation(id);
    }
    if (target === 'timezone' || target === 'all') {
      if (scope === 'chat') await settingsService.clearChatTimeZone(id);
      else await settingsService.clearUserTimeZone(id);
    }
    return { status: 'result', summary: summarize(await loadSettings(scope, id)) };
  } catch (error) {
    logger.warn(
      {
        scope,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      },
      'Unable to clear location settings',
    );
    return { status: 'error', message: 'Не удалось сбросить настройки города и часового пояса.' };
  }
}

const locationService = {
  getLocationSummary,
  setCity,
  setTimeZone,
  clearLocation,
};

export default locationService;
