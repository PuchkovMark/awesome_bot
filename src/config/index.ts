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
  IMAGE_PROVIDER: 'openai' | 'cloudflare';
  VK_ADMIN_IDS: string[];
  IMAGE_ADMIN_ONLY: boolean;
  IMAGE_MAX_PER_USER_PER_DAY: number;
  AI_MAX_RETRIES: number;
  MAX_REQUESTS_PER_MINUTE: number;
  MAX_HISTORY_MESSAGES: number;
  MAX_INPUT_CHARS: number;
  WEB_SEARCH_PROVIDER: 'none' | 'brave';
  BRAVE_SEARCH_API_KEY?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_IMAGE_MODEL: string;
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

export const config: AppConfig = {
  VK_TOKEN: required('VK_TOKEN'),
  VK_GROUP_ID: required('VK_GROUP_ID'),
  OPENCODE_API_KEY: process.env.OPENCODE_API_KEY,
  OPENCODE_MODEL: process.env.OPENCODE_MODEL || 'deepseek-v4.1-flash',
  OPENCODE_BASE_URL: process.env.OPENCODE_BASE_URL || 'https://opencode.ai/inference/go/openai/v1',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
  OPENAI_IMAGE_MODEL: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1',
  OPENAI_TRANSCRIPTION_MODEL: process.env.OPENAI_TRANSCRIPTION_MODEL || 'gpt-transcribe',
  OPENAI_TTS_MODEL: process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
  VOICE_ENABLED: process.env.VOICE_ENABLED === 'true',
  AI_PROVIDER: oneOf('AI_PROVIDER', ['opencode', 'openai'] as const, 'opencode'),
  IMAGE_PROVIDER: oneOf('IMAGE_PROVIDER', ['openai', 'cloudflare'] as const, 'openai'),
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
  WEB_SEARCH_PROVIDER: oneOf('WEB_SEARCH_PROVIDER', ['none', 'brave'] as const, 'none'),
  BRAVE_SEARCH_API_KEY: process.env.BRAVE_SEARCH_API_KEY,
  CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
  CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
  CLOUDFLARE_IMAGE_MODEL: process.env.CLOUDFLARE_IMAGE_MODEL || '@cf/black-forest-labs/flux-2-dev',
  PORT: optionalNumber('PORT', 3000),
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  BOT_NAME: process.env.BOT_NAME || 'awesome_bot',
  CONTEXT_TTL_HOURS: Math.min(24, positiveInteger('CONTEXT_TTL_HOURS', 24)),
  MAX_HISTORY_TOKENS: positiveInteger('MAX_HISTORY_TOKENS', 4000),
};

export default config;
