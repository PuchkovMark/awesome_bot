import dotenv from 'dotenv';

dotenv.config();

/**
 * Типизированная конфигурация приложения.
 */
export interface AppConfig {
  VK_TOKEN: string;
  VK_GROUP_ID: string;
  OPENCODE_API_KEY?: string;
  OPENCODE_MODEL: string;
  OPENCODE_BASE_URL: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL: string;
  OPENAI_IMAGE_MODEL: string;
  OPENAI_TRANSCRIPTION_MODEL: string;
  OPENAI_TTS_MODEL: string;
  VOICE_ENABLED: boolean;
  AI_PROVIDER: 'opencode' | 'openai';
  VK_ADMIN_IDS: string[];
  IMAGE_ADMIN_ONLY: boolean;
  IMAGE_MAX_PER_USER_PER_DAY: number;
  AI_MAX_RETRIES: number;
  MAX_REQUESTS_PER_MINUTE: number;
  MAX_HISTORY_MESSAGES: number;
  MAX_INPUT_CHARS: number;
  WEB_SEARCH_PROVIDER: 'none' | 'serper' | 'tavily';
  MEMEDAY_TIMEZONE: string;
  REAL_WORLD_DEFAULT_TIME_ZONE: string;
  REAL_WORLD_CURRENT_WEATHER_CACHE_SECONDS: number;
  REAL_WORLD_FORECAST_CACHE_SECONDS: number;
  REAL_WORLD_HOLIDAY_CACHE_SECONDS: number;
  REAL_WORLD_HOROSCOPE_CACHE_SECONDS: number;
  MEMORY_EMBEDDING_API_KEY?: string;
  MEMORY_EMBEDDING_MODEL: string;
  SERPER_API_KEY?: string;
  TAVILY_API_KEY?: string;
  PORT: number;
  LOG_LEVEL: string;
  BOT_NAME: string;
  CONTEXT_TTL_HOURS: number;
  MAX_HISTORY_TOKENS: number;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(`Environment variable ${name} is required`);
    }
    // In non-production allow startup for local development — return empty string and warn.
    // Avoid importing logger here to prevent circular dependency.
    // eslint-disable-next-line no-console
    console.warn(`Environment variable ${name} is not set; using empty string (development mode)`);
    return '';
  }
  return v;
}

function optionalNumber(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Environment variable ${name} must be a number`);
  return n;
}

function positiveInteger(name: string, fallback: number): number {
  const value = optionalNumber(name, fallback);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Environment variable ${name} must be a positive integer`);
  }
  return value;
}

function oneOf<T extends string>(name: string, values: readonly T[], fallback: T): T {
  const value = process.env[name];
  if (!value) return fallback;
  if (!values.includes(value as T)) {
    throw new Error(`Environment variable ${name} must be one of: ${values.join(', ')}`);
  }
  return value as T;
}

function timezone(name: string, fallback: string): string {
  const value = process.env[name] || fallback;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
  } catch {
    throw new Error(`Environment variable ${name} must be a valid IANA timezone`);
  }
  return value;
}

export const config: AppConfig = {
  VK_TOKEN: required('VK_TOKEN'),
  VK_GROUP_ID: required('VK_GROUP_ID'),
  OPENCODE_API_KEY: process.env.OPENCODE_API_KEY,
  OPENCODE_MODEL: process.env.OPENCODE_MODEL || 'deepseek-v4.1-flash',
  OPENCODE_BASE_URL: process.env.OPENCODE_BASE_URL || 'https://opencode.ai/inference/go/openai/v1',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
  OPENAI_IMAGE_MODEL: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2.6-flare',
  OPENAI_TRANSCRIPTION_MODEL: process.env.OPENAI_TRANSCRIPTION_MODEL || 'gpt-transcribe',
  OPENAI_TTS_MODEL: process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
  VOICE_ENABLED: process.env.VOICE_ENABLED === 'true',
  AI_PROVIDER: oneOf('AI_PROVIDER', ['opencode', 'openai'] as const, 'opencode'),
  VK_ADMIN_IDS: (process.env.VK_ADMIN_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),
  IMAGE_ADMIN_ONLY: process.env.IMAGE_ADMIN_ONLY !== 'false',
  IMAGE_MAX_PER_USER_PER_DAY: positiveInteger('IMAGE_MAX_PER_USER_PER_DAY', 20),
  AI_MAX_RETRIES: positiveInteger('AI_MAX_RETRIES', 2),
  MAX_REQUESTS_PER_MINUTE: positiveInteger('MAX_REQUESTS_PER_MINUTE', 10),
  MAX_HISTORY_MESSAGES: positiveInteger('MAX_HISTORY_MESSAGES', 30),
  MAX_INPUT_CHARS: positiveInteger('MAX_INPUT_CHARS', 12_000),
  WEB_SEARCH_PROVIDER: oneOf(
    'WEB_SEARCH_PROVIDER',
    ['none', 'serper', 'tavily'] as const,
    'serper',
  ),
  MEMEDAY_TIMEZONE: timezone('MEMEDAY_TIMEZONE', 'UTC'),
  REAL_WORLD_DEFAULT_TIME_ZONE: timezone('REAL_WORLD_DEFAULT_TIME_ZONE', 'Europe/Moscow'),
  REAL_WORLD_CURRENT_WEATHER_CACHE_SECONDS: positiveInteger(
    'REAL_WORLD_CURRENT_WEATHER_CACHE_SECONDS',
    600,
  ),
  REAL_WORLD_FORECAST_CACHE_SECONDS: positiveInteger('REAL_WORLD_FORECAST_CACHE_SECONDS', 1800),
  REAL_WORLD_HOLIDAY_CACHE_SECONDS: positiveInteger('REAL_WORLD_HOLIDAY_CACHE_SECONDS', 86400),
  REAL_WORLD_HOROSCOPE_CACHE_SECONDS: positiveInteger('REAL_WORLD_HOROSCOPE_CACHE_SECONDS', 86400),
  MEMORY_EMBEDDING_API_KEY:
    process.env.MEMORY_EMBEDDING_API_KEY || process.env.OPENAI_API_KEY || undefined,
  MEMORY_EMBEDDING_MODEL: process.env.MEMORY_EMBEDDING_MODEL || 'text-embedding-3-small',
  SERPER_API_KEY: process.env.SERPER_API_KEY,
  TAVILY_API_KEY: process.env.TAVILY_API_KEY,
  PORT: optionalNumber('PORT', 3000),
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  BOT_NAME: process.env.BOT_NAME || 'awesome_bot',
  CONTEXT_TTL_HOURS: Math.min(24, positiveInteger('CONTEXT_TTL_HOURS', 24)),
  MAX_HISTORY_TOKENS: positiveInteger('MAX_HISTORY_TOKENS', 4000),
};

export default config;
