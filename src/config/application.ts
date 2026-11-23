import { resolve } from 'node:path';
import { contextConfig } from '../core/context/config.js';
import { responseRateConfig } from '../core/chat-limits/response-rate-config.js';
import { traceConfig } from '../core/response-tracing/config.js';
import {
  baseConfig,
  ConfigError,
  ownerParameter,
  positiveParameter,
  readConfigParameters,
  requiredParameter,
  versionParameters,
} from './index.js';
import type { ConfigOptions, ConfigValues } from './index.js';

function databasePath(cwd: string, values: ConfigValues) {
  const path = requiredParameter(values, 'DATABASE_PATH');
  if (path === ':memory:' || path.includes('\0'))
    throw new ConfigError('invalid', ['DATABASE_PATH']);
  return resolve(cwd, path);
}

function modelContext(values: ConfigValues) {
  const modelContextTokens = positiveParameter(values, 'MODEL_CONTEXT_TOKENS');
  try {
    return contextConfig({ modelContextTokens });
  } catch {
    throw new ConfigError('invalid', ['MODEL_CONTEXT_TOKENS']);
  }
}

function vkOwner(values: ConfigValues) {
  const id = ownerParameter(values);
  const number = Number(id.slice(3));
  if (!Number.isSafeInteger(number) || number <= 0 || id !== `vk:${number}`) {
    throw new ConfigError('invalid', ['BOT_OWNER_ID']);
  }
  return id;
}

export function loadApplicationConfig(options?: ConfigOptions) {
  const { cwd, values, redact } = readConfigParameters(options);
  const base = baseConfig(values);
  const ownerId = vkOwner(values);
  const sessionSecret = requiredParameter(values, 'LLM_SESSION_SECRET');
  if (sessionSecret === base.vk.token || sessionSecret === base.llm.apiKey) {
    throw new ConfigError('invalid', ['LLM_SESSION_SECRET']);
  }
  const messageRetentionDays = positiveParameter(
    values,
    'MESSAGE_RETENTION_DAYS',
    undefined,
    86_400_000,
  );
  let tracing;
  try {
    tracing = traceConfig({ messageRetentionDays });
  } catch {
    throw new ConfigError('invalid', ['MESSAGE_RETENTION_DAYS']);
  }
  const defaults = responseRateConfig();
  const floodWindowMs = positiveParameter(
    values,
    'CHAT_MENTION_FLOOD_WINDOW_MS',
    defaults.floodWindowMs,
  );
  if (floodWindowMs > 8_640_000_000_000_000 - Date.now()) {
    throw new ConfigError('invalid', ['CHAT_MENTION_FLOOD_WINDOW_MS']);
  }
  const responseRate = responseRateConfig({
    responsesPerMinute: positiveParameter(
      values,
      'CHAT_RESPONSES_PER_MINUTE',
      defaults.responsesPerMinute,
    ),
    floodThreshold: positiveParameter(
      values,
      'CHAT_MENTION_FLOOD_THRESHOLD',
      defaults.floodThreshold,
    ),
    floodWindowMs,
  });
  return Object.freeze({
    config: Object.freeze({
      ...base,
      authorization: Object.freeze({ ...base.authorization, ownerId }),
      vk: Object.freeze({ ...base.vk, groupId: positiveParameter(values, 'VK_GROUP_ID') }),
      databasePath: databasePath(cwd, values),
      context: modelContext(values),
      sessionSecret,
      tracing,
      responseRate,
    }),
    redact,
  });
}

export type ApplicationConfig = ReturnType<typeof loadApplicationConfig>['config'];

export function loadPromptConfig(options?: ConfigOptions) {
  const { cwd, values } = readConfigParameters(options);
  return {
    databasePath: databasePath(cwd, values),
    context: modelContext(values),
    versioning: versionParameters(values),
  };
}

export function loadResolutionConfig(options?: ConfigOptions) {
  const { cwd, values } = readConfigParameters(options);
  return { databasePath: databasePath(cwd, values), ownerId: vkOwner(values) };
}
