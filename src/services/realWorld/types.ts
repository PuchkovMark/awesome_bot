import type { RealWorldLocation } from '../settings/settingsService.js';

export type WeatherPeriod =
  'current' | 'today' | 'tomorrow' | 'after_tomorrow' | 'weekend' | 'week';
export type HoroscopePeriod = 'today' | 'tomorrow' | 'week';
export type HoroscopeCategory = 'general' | 'love' | 'work';

export type ContextCategory = 'date_time' | 'weather' | 'calendar' | 'horoscope';

export interface ContextFact<T = unknown> {
  category: ContextCategory;
  source: string;
  retrievedAt: string;
  expiresAt?: string;
  data: T;
}

export interface ProviderRequest {
  text: string;
  previousMessages: string[];
  isChat: boolean;
  now: Date;
  timeZone: string;
  timeZoneSource: 'user' | 'chat' | 'location' | 'project-default';
  location?: RealWorldLocation;
  countryCode?: string;
  weatherPeriod?: WeatherPeriod;
  horoscope?: HoroscopeRequest;
  needsCalendar: boolean;
  calendarDaysAhead?: number;
}

export interface RealWorldContextProvider {
  readonly category: ContextCategory;
  getContext(request: ProviderRequest): Promise<ContextFact | undefined>;
}

export interface DateTimeContext {
  utcNow: string;
  localDate: string;
  localTime: string;
  dayOfWeek: string;
  timeZone: string;
  timeZoneSource: 'user' | 'chat' | 'location' | 'project-default';
  utcOffset: string;
  tomorrow: string;
  daysUntilSaturday: number;
  daysUntilNewYear: number;
}

export interface WeatherCurrent {
  temperatureC?: number;
  feelsLikeC?: number;
  condition?: string;
  windSpeedKmh?: number;
  windDirection?: string;
  humidityPercent?: number;
  pressureHpa?: number;
  precipitationMm?: number;
}

export interface WeatherDay {
  date: string;
  condition?: string;
  minTemperatureC?: number;
  maxTemperatureC?: number;
  precipitationProbabilityPercent?: number;
  rainMm?: number;
  snowfallCm?: number;
  maxWindSpeedKmh?: number;
  dominantWindDirection?: string;
}

export interface WeatherContextData {
  location: string;
  current?: WeatherCurrent;
  days?: WeatherDay[];
  period: WeatherPeriod;
  currentRetrievedAt?: string;
  forecastRetrievedAt?: string;
}

export interface HoroscopeRequest {
  sign: string;
  period: HoroscopePeriod;
  category: HoroscopeCategory;
}

export interface HoroscopeContextData extends HoroscopeRequest {
  date: string;
  content: string;
}

export interface ContextRelevance {
  weatherPeriod?: WeatherPeriod;
  explicitLocation?: string;
  explicitWeather: boolean;
  explicitDateTime: boolean;
  explicitCountryCode?: string;
  needsCalendar: boolean;
  horoscope?: HoroscopeRequest;
}

export interface LocationResolution {
  location?: RealWorldLocation;
  ambiguous?: RealWorldLocation[];
}
