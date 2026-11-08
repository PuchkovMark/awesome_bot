import config from '../../config/index.js';
import { logger } from '../../logger/index.js';
import type { RealWorldLocation } from '../settings/settingsService.js';
import { DateTimeProvider } from './dateTimeProvider.js';
import { detectContextRelevance, getCountryCodeForLocationName } from './contextRelevance.js';
import { HolidayProvider } from './holidayProvider.js';
import { LocationNotFoundError, OpenMeteoProvider } from './openMeteoProvider.js';
import type {
  ContextFact,
  ContextRelevance,
  DateTimeContext,
  LocationResolution,
  ProviderRequest,
  RealWorldContextProvider,
} from './types.js';

export interface RealWorldPreferences {
  locationName: string | null;
  locationLatitude: number | null;
  locationLongitude: number | null;
  locationCountry: string | null;
  locationRegion: string | null;
  locationTimeZone: string | null;
  timeZone: string | null;
}

export interface RealWorldSettingsIntent {
  scope: 'user' | 'chat';
  type: 'location' | 'timeZone';
  query?: string;
}

export interface PreparedRealWorldContext {
  relevance: ContextRelevance;
  facts: ContextFact[];
  prompt: string;
  dateTime: DateTimeContext;
  location?: RealWorldLocation;
  locationProblem?: 'missing' | 'ambiguous' | 'unavailable';
  locationCandidates?: RealWorldLocation[];
  timeZoneProblem?: 'ambiguous' | 'unavailable';
}

export interface PrepareContextInput {
  text: string;
  previousMessages: string[];
  isChat: boolean;
  now: Date;
  userPreferences: RealWorldPreferences;
  chatPreferences: RealWorldPreferences;
}

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function getStoredLocation(preferences: RealWorldPreferences): RealWorldLocation | undefined {
  if (
    !preferences.locationName ||
    preferences.locationLatitude === null ||
    preferences.locationLongitude === null
  ) {
    return undefined;
  }
  return {
    name: preferences.locationName,
    latitude: preferences.locationLatitude,
    longitude: preferences.locationLongitude,
    ...(preferences.locationCountry ? { countryCode: preferences.locationCountry } : {}),
    ...(preferences.locationRegion ? { region: preferences.locationRegion } : {}),
    ...(preferences.locationTimeZone && isValidTimeZone(preferences.locationTimeZone)
      ? { timeZone: preferences.locationTimeZone }
      : {}),
  };
}

function cleanQuery(value: string): string {
  return value
    .replace(/[.!?;,:]+$/gu, '')
    .replace(/\s+(?:пожалуйста|бот|пенек|пенечек)$/iu, '')
    .trim();
}

/**
 * Определяет релевантность реального контекста и объединяет данные погоды, календаря и времени.
 */
export class RealWorldContextService {
  readonly locationProvider: OpenMeteoProvider;
  private readonly providers: RealWorldContextProvider[];
  private readonly dateTimeProvider = new DateTimeProvider();
  private readonly lastErrorLogAt = new Map<string, number>();

  constructor(
    locationProvider = new OpenMeteoProvider(),
    calendarProvider: RealWorldContextProvider = new HolidayProvider(),
  ) {
    this.locationProvider = locationProvider;
    this.providers = [this.dateTimeProvider, locationProvider, calendarProvider];
  }

  parseSettingsIntent(text: string): RealWorldSettingsIntent | undefined {
    const normalized = text
      .normalize('NFKC')
      .replace(/[\u200B-\u200D\uFEFF]/gu, '')
      .replace(/ё/giu, 'е')
      .trim()
      .replace(/^(?:пенек|пенечек)[,!:;]?\s*/iu, '');

    const groupLocation = normalized.match(
      /^для\s+этой\s+беседы\s+(?:установи|измени|запомни)\s+город(?:\s+на)?\s+(.+?)\s*[.!?]*$/iu,
    );
    if (groupLocation) {
      return { scope: 'chat', type: 'location', query: cleanQuery(groupLocation[1]) };
    }

    const groupTimeZone = normalized.match(
      /^для\s+этой\s+беседы\s+(?:используй|установи|измени)\s+(?:часовой\s+пояс|время)(?:\s+в)?\s*(.*?)\s*[.!?]*$/iu,
    );
    if (groupTimeZone) {
      return {
        scope: 'chat',
        type: 'timeZone',
        ...(cleanQuery(groupTimeZone[1]) ? { query: cleanQuery(groupTimeZone[1]) } : {}),
      };
    }

    const userTimeZone = normalized.match(
      /^(?:(?:установи|измени)\s+)?мой\s+часовой\s+пояс(?:\s+(?:на|это))?\s*(.*?)\s*[.!?]*$/iu,
    );
    if (userTimeZone) {
      return {
        scope: 'user',
        type: 'timeZone',
        ...(cleanQuery(userTimeZone[1]) ? { query: cleanQuery(userTimeZone[1]) } : {}),
      };
    }

    const userLocation =
      normalized.match(
        /^(?:запомни(?:,?\s+что)?\s+)?я\s+(?:живу|нахожусь)\s+в\s+(.+?)\s*[.!?]*$/iu,
      ) ??
      normalized.match(
        /^(?:запомни\s+)?(?:установи|измени)\s+мой\s+город(?:\s+на)?\s+(.+?)\s*[.!?]*$/iu,
      );
    if (userLocation) {
      return { scope: 'user', type: 'location', query: cleanQuery(userLocation[1]) };
    }
    return undefined;
  }

  async resolveLocation(query: string): Promise<LocationResolution> {
    return this.locationProvider.resolveLocation(query);
  }

  async prepare(input: PrepareContextInput): Promise<PreparedRealWorldContext> {
    const relevance = detectContextRelevance(input.text, input.previousMessages);
    const explicitCountry =
      relevance.explicitCountryCode &&
      (!relevance.explicitLocation ||
        getCountryCodeForLocationName(relevance.explicitLocation) ===
          relevance.explicitCountryCode) &&
      (relevance.needsCalendar || relevance.weatherPeriod || relevance.explicitDateTime)
        ? relevance.explicitCountryCode
        : undefined;
    let location = input.isChat
      ? getStoredLocation(input.chatPreferences)
      : (getStoredLocation(input.userPreferences) ?? getStoredLocation(input.chatPreferences));
    let locationProblem: PreparedRealWorldContext['locationProblem'];
    let timeZoneProblem: PreparedRealWorldContext['timeZoneProblem'];
    let locationCandidates: RealWorldLocation[] | undefined;

    if (explicitCountry) {
      location = undefined;
    } else if (relevance.explicitLocation) {
      location = undefined;
      try {
        const result = await this.resolveLocation(relevance.explicitLocation);
        if (result.location) {
          location = result.location;
        } else if (result.ambiguous) {
          locationProblem = 'ambiguous';
          locationCandidates = result.ambiguous;
        }
      } catch (error) {
        locationProblem = error instanceof LocationNotFoundError ? 'missing' : 'unavailable';
        if (!(error instanceof LocationNotFoundError)) {
          this.logProviderError('geocoding', error);
        }
      }
    }
    const preferences = input.isChat ? input.chatPreferences : input.userPreferences;
    const explicitTimeZone = relevance.explicitDateTime && relevance.explicitLocation;
    const timeZone =
      explicitTimeZone && location?.timeZone
        ? location.timeZone
        : preferences.timeZone && isValidTimeZone(preferences.timeZone)
          ? preferences.timeZone
          : (location?.timeZone ?? config.REAL_WORLD_DEFAULT_TIME_ZONE);
    const timeZoneSource: ProviderRequest['timeZoneSource'] =
      explicitTimeZone && location?.timeZone
        ? 'location'
        : preferences.timeZone && isValidTimeZone(preferences.timeZone)
          ? input.isChat
            ? 'chat'
            : 'user'
          : location?.timeZone
            ? 'location'
            : 'project-default';

    if (relevance.weatherPeriod && !location && !locationProblem) {
      locationProblem = 'missing';
    }
    if (explicitTimeZone) {
      if (explicitCountry) {
        timeZoneProblem = 'ambiguous';
      } else if (!location) {
        timeZoneProblem = locationProblem === 'unavailable' ? 'unavailable' : 'ambiguous';
      } else if (!location.timeZone) {
        timeZoneProblem = 'unavailable';
      }
    }

    const request: ProviderRequest = {
      text: input.text,
      previousMessages: input.previousMessages,
      isChat: input.isChat,
      now: input.now,
      timeZone,
      timeZoneSource,
      ...(location ? { location } : {}),
      ...(explicitCountry ? { countryCode: explicitCountry } : {}),
      ...(relevance.weatherPeriod ? { weatherPeriod: relevance.weatherPeriod } : {}),
      needsCalendar: relevance.needsCalendar,
    };
    const facts: ContextFact[] = [];
    facts.push(await this.dateTimeProvider.getContext(request));

    const providers = this.providers.filter((provider) => provider.category !== 'date_time');
    const results = await Promise.all(
      providers.map(async (provider) => {
        if (provider.category === 'weather' && (!relevance.weatherPeriod || !location)) {
          return undefined;
        }
        if (provider.category === 'calendar' && !relevance.needsCalendar) return undefined;
        if (provider.category === 'calendar' && !location?.countryCode && !request.countryCode) {
          return undefined;
        }
        try {
          return await provider.getContext(request);
        } catch (error) {
          this.logProviderError(provider.category, error);
          return undefined;
        }
      }),
    );
    facts.push(...results.filter((fact): fact is ContextFact => fact !== undefined));
    const dateTimeFact = facts.find((fact) => fact.category === 'date_time');
    const dateTimeData = dateTimeFact?.data as DateTimeContext | undefined;
    if (!dateTimeData) throw new Error('Date/time provider did not return context.');

    return {
      relevance,
      facts,
      prompt: this.formatPrompt(
        facts,
        relevance,
        locationProblem,
        location,
        locationCandidates,
        explicitCountry,
        timeZoneProblem,
      ),
      dateTime: dateTimeData,
      ...(location ? { location } : {}),
      ...(locationProblem ? { locationProblem } : {}),
      ...(locationCandidates ? { locationCandidates } : {}),
      ...(timeZoneProblem ? { timeZoneProblem } : {}),
    };
  }

  private formatPrompt(
    facts: ContextFact[],
    relevance: ContextRelevance,
    locationProblem: PreparedRealWorldContext['locationProblem'],
    location?: RealWorldLocation,
    candidates?: RealWorldLocation[],
    countryCode?: string,
    timeZoneProblem?: PreparedRealWorldContext['timeZoneProblem'],
  ): string {
    const sections = [
      'Актуальный контекст реального мира для этого ответа. Доверяй этим фактам, а не внутренним знаниям модели. Не изменяй значения, не выдумывай отсутствующие измерения и не называй данные текущими, если они устарели.',
      ...facts.map(
        (fact) =>
          `${fact.category} | источник: ${fact.source} | получено: ${fact.retrievedAt}${fact.expiresAt ? ` | актуально до: ${fact.expiresAt}` : ''}\n${JSON.stringify(fact.data)}`,
      ),
    ];
    if (facts.some((fact) => fact.category === 'calendar')) {
      sections.push(
        'Для регионального праздника проверяй global и counties. Указывай его только если региональный код однозначно относится к указанному региону; не угадывай соответствие кодов и названий. При сомнении сообщай только о национальных праздниках.',
      );
    }
    if (relevance.weatherPeriod && locationProblem === 'missing') {
      sections.push(
        'Для погоды нет однозначно определённого города. Если пользователь явно спросил о погоде, попроси указать город; не используй местоположение сервера и не угадывай.',
      );
    } else if (relevance.weatherPeriod && locationProblem === 'ambiguous') {
      sections.push(
        `Город не определён однозначно. Попроси пользователя уточнить страну или выбрать вариант: ${JSON.stringify(candidates?.map(({ name, countryCode }) => ({ name, countryCode })) ?? [])}.`,
      );
    } else if (relevance.weatherPeriod && locationProblem === 'unavailable') {
      sections.push(
        'Не удалось получить координаты запрошенного места. Честно попроси уточнить город; не подменяй его сохранённым городом.',
      );
    }
    if (relevance.needsCalendar && !facts.some((fact) => fact.category === 'calendar')) {
      sections.push(
        `Подтверждённые праздники для региона недоступны. Не называй конкретные местные праздники без источника; ${location?.countryCode || countryCode ? 'сообщи, что источник временно недоступен.' : 'попроси указать город или страну.'}`,
      );
    }
    if (
      relevance.weatherPeriod &&
      !facts.some((fact) => fact.category === 'weather') &&
      !locationProblem
    ) {
      sections.push(
        'Погодный провайдер не вернул актуальные данные. Честно сообщи, что сейчас не удалось проверить погоду, и не пытайся угадать её.',
      );
    }
    if (timeZoneProblem === 'ambiguous') {
      sections.push(
        'Для запрошенного места нельзя однозначно определить часовой пояс. Попроси указать город; не отвечай по сохранённому или часовому поясу проекта.',
      );
    } else if (timeZoneProblem === 'unavailable') {
      sections.push(
        'Не удалось определить часовой пояс запрошенного места. Честно сообщи об этом и попроси уточнить город; не используй часовой пояс проекта как местный.',
      );
    }
    if (facts.some((fact) => fact.category === 'date_time')) {
      const dateTime = facts.find((fact) => fact.category === 'date_time')?.data as
        DateTimeContext | undefined;
      if (dateTime?.timeZoneSource === 'project-default') {
        sections.push(
          'Часовой пояс взят из настройки проекта, а не подтверждён как местный часовой пояс пользователя.',
        );
      }
    }
    return sections.join('\n\n');
  }

  private logProviderError(category: string, error: unknown): void {
    const now = Date.now();
    for (const [key, loggedAt] of this.lastErrorLogAt) {
      if (now - loggedAt >= 60_000) this.lastErrorLogAt.delete(key);
    }
    const previous = this.lastErrorLogAt.get(category);
    if (previous !== undefined && now - previous < 60_000) return;
    this.lastErrorLogAt.set(category, now);
    logger.warn({ category, err: error }, 'Real-world context provider failed');
  }
}

const realWorldContextService = new RealWorldContextService();
export default realWorldContextService;
