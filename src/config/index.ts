import { defaultVersionLimits } from '../storage/version-limits.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { ConfigError } from './errors.js';
import { createRedactor } from './secrets.js';
import { configParameters, logLevels } from './types.js';
import type { UserId } from '../contracts/index.js';
import type { ConfigParameter, LoadedConfig, LogLevel } from './types.js';

export { ConfigError } from './errors.js';
export type { AppConfig, LoadedConfig, LogLevel, Redact } from './types.js';

export interface ConfigOptions {
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  envFile?: string;
  readFile?: (path: string) => string;
}

export function loadConfig(options: ConfigOptions = {}): LoadedConfig {
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  let file: Record<string, string | undefined> = {};
  try {
    file = parseEnv(readFile(resolve(options.cwd ?? process.cwd(), options.envFile ?? '.env')));
  } catch (error) {
    const missing = typeof error === 'object' && error !== null
      && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'ENOENT';
    if (!missing || options.envFile !== undefined) {
      throw new ConfigError(missing ? 'env_file_missing' : 'env_file_unreadable');
    }
  }

  const values = Object.fromEntries(configParameters.map((key) => [key, env[key] ?? file[key]]));
  const required = ['VK_TOKEN', 'OPENCODE_API_KEY', 'LLM_MODEL', 'BOT_OWNER_ID'] as const;
  for (const parameter of required) {
    const value = values[parameter];
    if (value === undefined) throw new ConfigError('missing', [parameter]);
    if (typeof value !== 'string' || !value || value.trim() !== value || /[\r\n]/.test(value)) {
      throw new ConfigError('invalid', [parameter]);
    }
  }
  const level = values.LOG_LEVEL === undefined ? 'info' : values.LOG_LEVEL;
  if (!logLevels.includes(level as LogLevel)) throw new ConfigError('invalid', ['LOG_LEVEL']);
  if (!/^[a-z][a-z0-9_-]*:[^\s]+$/.test(values.BOT_OWNER_ID as string)) throw new ConfigError('invalid', ['BOT_OWNER_ID']);
  function positive(parameter: ConfigParameter, fallback: number, unit = 1): number {
    const raw = values[parameter];
    const number = raw === undefined ? fallback : (typeof raw === 'string' && /^[0-9]+$/.test(raw) ? Number(raw) : NaN);
    if (!Number.isSafeInteger(number) || number <= 0 || !Number.isSafeInteger(number * unit)) throw new ConfigError('invalid', [parameter]);
    return number;
  }
  const config = Object.freeze({
    versioning: Object.freeze({textMaxLength:positive('VERSION_TEXT_MAX_LENGTH',defaultVersionLimits.textMaxLength),maxPerEntity:positive('VERSION_MAX_PER_ENTITY',defaultVersionLimits.maxPerEntity)}),
    authorization: Object.freeze({
      ownerId: values.BOT_OWNER_ID as UserId,
      reasonMaxLength: positive('ADMIN_REVOCATION_REASON_MAX_LENGTH', 500),
      reasonRetentionDays: positive('ADMIN_REVOCATION_REASON_RETENTION_DAYS', 90, 86_400_000),
    }),
    vk: Object.freeze({ token: values.VK_TOKEN as string }),
    llm: Object.freeze({ provider: 'opencode' as const, apiKey: values.OPENCODE_API_KEY as string, model: values.LLM_MODEL as string }),
    log: Object.freeze({ level: level as LogLevel }),
  });
  const secretParameters: readonly ConfigParameter[] = ['VK_TOKEN', 'OPENCODE_API_KEY'];
  const secrets = secretParameters.flatMap((key) => [env[key], file[key]])
    .filter((value): value is string => typeof value === 'string');
  return Object.freeze({ config, redact: createRedactor(secrets) });
}
