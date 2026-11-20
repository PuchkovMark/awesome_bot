import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { ConfigError } from './errors.js';
import { createRedactor } from './secrets.js';
import { configParameters, logLevels } from './types.js';
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
  const required = ['VK_TOKEN', 'OPENCODE_API_KEY', 'LLM_MODEL'] as const;
  for (const parameter of required) {
    const value = values[parameter];
    if (value === undefined) throw new ConfigError('missing', [parameter]);
    if (typeof value !== 'string' || !value || value.trim() !== value || /[\r\n]/.test(value)) {
      throw new ConfigError('invalid', [parameter]);
    }
  }
  const level = values.LOG_LEVEL === undefined ? 'info' : values.LOG_LEVEL;
  if (!logLevels.includes(level as LogLevel)) throw new ConfigError('invalid', ['LOG_LEVEL']);
  const config = Object.freeze({
    vk: Object.freeze({ token: values.VK_TOKEN as string }),
    llm: Object.freeze({ provider: 'opencode' as const, apiKey: values.OPENCODE_API_KEY as string, model: values.LLM_MODEL as string }),
    log: Object.freeze({ level: level as LogLevel }),
  });
  const secretParameters: readonly ConfigParameter[] = ['VK_TOKEN', 'OPENCODE_API_KEY'];
  const secrets = secretParameters.flatMap((key) => [env[key], file[key]])
    .filter((value): value is string => typeof value === 'string');
  return Object.freeze({ config, redact: createRedactor(secrets) });
}
