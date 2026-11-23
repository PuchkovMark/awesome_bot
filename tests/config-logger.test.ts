import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { loadConfig } from '../src/config/index';
import type { ConfigOptions } from '../src/config/index';
import type { AppConfig } from '../src/config/types';
import { createLogger, reportConfigError } from '../src/logger/index';
import { captureLogs } from './helpers/log-output';

const valid = {
  BOT_OWNER_ID: 'vk:owner',
  VK_TOKEN: 'environment-vk-secret',
  OPENCODE_API_KEY: 'environment-opencode-secret',
  LLM_MODEL: 'deepseek-v4.1-flash',
  LOG_LEVEL: 'debug',
};
const absent = () => {
  throw Object.assign(new Error('missing'), { code: 'ENOENT' });
};

function compose(options: ConfigOptions, consumer: (config: AppConfig) => void) {
  const output = captureLogs();
  try {
    const loaded = loadConfig(options);
    const logger = createLogger({
      level: loaded.config.log.level,
      redact: loaded.redact,
      destination: output.destination,
    });
    logger.event({ event: 'config_loaded' });
    consumer(loaded.config);
    return { output, logger };
  } catch (error) {
    reportConfigError(error, output.destination);
    return { output };
  }
}

test('некорректный конфиг не создаёт зависимый компонент, диагностика безопасна', () => {
  const factory = vi.fn();
  const { output } = compose(
    { env: { ...valid, OPENCODE_API_KEY: '' }, readFile: absent },
    factory,
  );
  expect(factory).not.toHaveBeenCalled();
  expect(output.records()).toHaveLength(1);
  expect(output.records()[0]?.parameters).toEqual(['OPENCODE_API_KEY']);
  expect(output.text()).not.toContain(valid.VK_TOKEN);
  expect(output.text()).not.toContain(valid.OPENCODE_API_KEY);
});

test('потребитель получает выбранную модель; ключи и конфиг не логируются', () => {
  const factory = vi.fn();
  const { output } = compose({ env: valid, readFile: absent }, factory);
  expect(factory).toHaveBeenCalledOnce();
  const config = factory.mock.calls[0]?.[0] as AppConfig;
  expect(config.llm.provider).toBe('opencode');
  expect(config.llm.model).toBe('deepseek-v4.1-flash');
  expect(output.records()[0]?.event).toBe('config_loaded');
  for (const value of Object.values(valid)) expect(output.text()).not.toContain(value);
});

test('выходной отладочный текст очищает активные и перекрытые ключи обоих источников', () => {
  const directory = mkdtempSync(join(tmpdir(), 'awesome-config-logger-'));
  try {
    writeFileSync(
      join(directory, '.env'),
      'VK_TOKEN=file-vk-secret\nOPENCODE_API_KEY=file-opencode-secret\n',
    );
    const factory = vi.fn();
    const { output, logger } = compose({ env: valid, cwd: directory }, factory);
    logger?.debugText(
      `${valid.VK_TOKEN} ${valid.OPENCODE_API_KEY} file-vk-secret file-opencode-secret`,
    );
    for (const value of [
      valid.VK_TOKEN,
      valid.OPENCODE_API_KEY,
      'file-vk-secret',
      'file-opencode-secret',
    ]) {
      expect(output.text()).not.toContain(value);
    }
    expect(output.records().at(-1)?.text).toBe('[REDACTED] [REDACTED] [REDACTED] [REDACTED]');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('ошибка чтения диагностируется до создания основного логгера', () => {
  const factory = vi.fn();
  const { output } = compose(
    {
      env: valid,
      readFile: () => {
        throw new Error(`private path ${valid.OPENCODE_API_KEY}`);
      },
    },
    factory,
  );
  expect(factory).not.toHaveBeenCalled();
  expect(output.records()[0]?.code).toBe('env_file_unreadable');
  expect(output.text()).not.toContain('private path');
  expect(output.text()).not.toContain(valid.OPENCODE_API_KEY);
});
