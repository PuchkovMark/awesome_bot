import dotenv from 'dotenv';

dotenv.config();

/**
 * Типизированная конфигурация приложения.
 */
export interface AppConfig {
  VK_TOKEN: string;
  VK_GROUP_ID: string;
  DATABASE_URL: string;
  OPENAI_API_KEY?: string;
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

export const config: AppConfig = {
  VK_TOKEN: required('VK_TOKEN'),
  VK_GROUP_ID: required('VK_GROUP_ID'),
  DATABASE_URL: process.env.DATABASE_URL || 'file:./dev.db',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  PORT: optionalNumber('PORT', 3000),
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  BOT_NAME: process.env.BOT_NAME || 'awesome_bot',
  CONTEXT_TTL_HOURS: optionalNumber('CONTEXT_TTL_HOURS', 24),
  MAX_HISTORY_TOKENS: optionalNumber('MAX_HISTORY_TOKENS', 4000),
};

export default config;
