import { defaultVersionLimits } from '../storage/version-limits.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { ConfigError } from './errors.js';
import { createRedactor } from './secrets.js';
import { configParameters, logLevels } from './types.js';
import type { UserId } from '../contracts/index.js';
import type { AppConfig, ConfigParameter, LoadedConfig, LogLevel } from './types.js';

export { ConfigError } from './errors.js';
export type { AppConfig, LoadedConfig, LogLevel, Redact } from './types.js';

export interface ConfigOptions {
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  envFile?: string;
  readFile?: (path: string) => string;
}

export type ConfigValues = Readonly<Partial<Record<ConfigParameter, string>>>;

export function readConfigParameters(options: ConfigOptions = {}) {
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const cwd = options.cwd ?? process.cwd();
  let file: Record<string, string | undefined> = {};
  try {
    file = parseEnv(readFile(resolve(cwd, options.envFile ?? '.env')));
  } catch (error) {
    const missing = typeof error === 'object' && error !== null
      && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'ENOENT';
    if (!missing || options.envFile !== undefined) {
      throw new ConfigError(missing ? 'env_file_missing' : 'env_file_unreadable');
    }
  }

  const values: ConfigValues = Object.fromEntries(configParameters.map(key => [key, env[key] ?? file[key]]));
  const secretParameters = ['VK_TOKEN', 'OPENCODE_API_KEY', 'LLM_SESSION_SECRET'] as const;
  const secrets = secretParameters.flatMap(key => [env[key], file[key]])
    .filter((value): value is string => typeof value === 'string');
  return { cwd, values, redact: createRedactor(secrets) };
}

export function requiredParameter(values: ConfigValues, parameter: ConfigParameter): string {
  const value = values[parameter];
  if (value === undefined) throw new ConfigError('missing', [parameter]);
  if (typeof value !== 'string' || !value || value.trim() !== value || /[\r\n]/.test(value)) {
    throw new ConfigError('invalid', [parameter]);
  }
  return value;
}

export function positiveParameter(values: ConfigValues, parameter: ConfigParameter, fallback?: number, unit = 1): number {
  const raw = values[parameter];
  if (raw === undefined && fallback === undefined) throw new ConfigError('missing', [parameter]);
  const value = raw === undefined ? fallback! : (typeof raw === 'string' && /^[0-9]+$/.test(raw) ? Number(raw) : NaN);
  if (!Number.isSafeInteger(value) || value <= 0 || !Number.isSafeInteger(value * unit)) throw new ConfigError('invalid', [parameter]);
  return value;
}

export function ownerParameter(values: ConfigValues): UserId {
  const owner = requiredParameter(values, 'BOT_OWNER_ID');
  if (!/^[a-z][a-z0-9_-]*:[^\s]+$/.test(owner)) throw new ConfigError('invalid', ['BOT_OWNER_ID']);
  return owner as UserId;
}

export function versionParameters(values: ConfigValues) {
  return Object.freeze({
    textMaxLength: positiveParameter(values, 'VERSION_TEXT_MAX_LENGTH', defaultVersionLimits.textMaxLength),
    maxPerEntity: positiveParameter(values, 'VERSION_MAX_PER_ENTITY', defaultVersionLimits.maxPerEntity),
  });
}

export function baseConfig(values: ConfigValues): AppConfig {
  const token = requiredParameter(values, 'VK_TOKEN');
  const apiKey = requiredParameter(values, 'OPENCODE_API_KEY');
  const model = requiredParameter(values, 'LLM_MODEL');
  requiredParameter(values, 'BOT_OWNER_ID');
  const level = values.LOG_LEVEL === undefined ? 'info' : values.LOG_LEVEL;
  if (!logLevels.includes(level as LogLevel)) throw new ConfigError('invalid', ['LOG_LEVEL']);
  const ownerId = ownerParameter(values);
  return Object.freeze({
    versioning: versionParameters(values),
    authorization: Object.freeze({
      ownerId,
      reasonMaxLength: positiveParameter(values, 'ADMIN_REVOCATION_REASON_MAX_LENGTH', 500),
      reasonRetentionDays: positiveParameter(values, 'ADMIN_REVOCATION_REASON_RETENTION_DAYS', 90, 86_400_000),
    }),
    vk: Object.freeze({ token }),
    llm: Object.freeze({ provider: 'opencode', apiKey, model }),
    log: Object.freeze({ level: level as LogLevel }),
  });
}

export function loadConfig(options: ConfigOptions = {}): LoadedConfig {
  const { values, redact } = readConfigParameters(options);
  return Object.freeze({ config: baseConfig(values), redact });
}
