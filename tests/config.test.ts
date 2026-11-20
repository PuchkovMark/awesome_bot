import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { ConfigError, loadConfig } from '../src/config/index.js';
import { createRedactor } from '../src/config/secrets.js';

const valid = { VK_TOKEN: 'vk-test-secret', OPENCODE_API_KEY: 'opencode-test-secret', LLM_MODEL: 'deepseek-v4.1-flash' };
const absent = () => { throw Object.assign(new Error('private path'), { code: 'ENOENT' }); };

test('валидный неизменяемый конфиг и info по умолчанию, без изменения окружения', () => {
  const env = { ...valid, PRIVATE_EXTRA: 'not copied' };
  const { config } = loadConfig({ env, readFile: absent });
  expect(config).toEqual({
    vk: { token: valid.VK_TOKEN },
    llm: { provider: 'opencode', apiKey: valid.OPENCODE_API_KEY, model: valid.LLM_MODEL },
    log: { level: 'info' },
  });
  expect(env).toEqual({ ...valid, PRIVATE_EXTRA: 'not copied' });
  for (const value of [config, config.vk, config.llm, config.log]) expect(Object.isFrozen(value)).toBe(true);
});

for (const parameter of ['VK_TOKEN', 'OPENCODE_API_KEY', 'LLM_MODEL'] as const) {
  test.each([undefined, '', ' ', ' x', 'x ', 'x\ny', 'x\ry'])(`${parameter}: отклоняется %j`, (value) => {
    try {
      loadConfig({ env: { ...valid, [parameter]: value }, readFile: absent });
      expect.unreachable('Конфиг должен быть отклонён');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).parameters).toEqual([parameter]);
      expect((error as ConfigError).code).toBe(value === undefined ? 'missing' : 'invalid');
      expect(JSON.stringify(error)).not.toContain(valid.OPENCODE_API_KEY);
    }
  });
}

test.each(['debug', 'info', 'warn', 'error', 'fatal', 'silent'])( 'уровень %s', (level) => {
  expect(loadConfig({ env: { ...valid, LOG_LEVEL: level }, readFile: absent }).config.log.level).toBe(level);
});
test.each(['', ' ', 'DEBUG', 'trace', 'invalid'])( 'некорректный уровень %j', (level) => {
  expect(() => loadConfig({ env: { ...valid, LOG_LEVEL: level }, readFile: absent })).toThrow('LOG_LEVEL');
});

test('временный .env, приоритет окружения и очистка перекрытых секретов', () => {
  const directory = mkdtempSync(join(tmpdir(), 'awesome-config-'));
  try {
    writeFileSync(join(directory, '.env'), 'VK_TOKEN=file-vk-secret\nOPENCODE_API_KEY=file-key-secret\nLLM_MODEL=deepseek-v4.1-flash\nLOG_LEVEL=debug\n');
    const loaded = loadConfig({ env: { VK_TOKEN: valid.VK_TOKEN }, cwd: directory });
    expect(loaded.config.vk.token).toBe(valid.VK_TOKEN);
    expect(loaded.config.llm.apiKey).toBe('file-key-secret');
    expect(loaded.config.log.level).toBe('debug');
    const text = loaded.redact(`${valid.VK_TOKEN} file-vk-secret file-key-secret`);
    expect(text).toBe('[REDACTED] [REDACTED] [REDACTED]');
    expect(() => loadConfig({ env: { VK_TOKEN: '' }, cwd: directory })).toThrow('VK_TOKEN');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('отсутствующий явный файл и недоступный файл дают безопасные ошибки', () => {
  expect(() => loadConfig({ env: valid, envFile: 'custom.env', readFile: absent })).toThrow('env_file_missing');
  for (const code of ['EACCES', 'EISDIR']) {
    try {
      loadConfig({ env: valid, readFile: () => { throw Object.assign(new Error(valid.OPENCODE_API_KEY), { code }); } });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).code).toBe('env_file_unreadable');
      expect(String(error)).not.toContain(valid.OPENCODE_API_KEY);
      expect((error as Error).cause).toBeUndefined();
    }
  }
});

test('Anthropic-ключ не заменяет OPENCODE_API_KEY', () => {
  expect(() => loadConfig({ env: { VK_TOKEN: valid.VK_TOKEN, LLM_MODEL: valid.LLM_MODEL, ANTHROPIC_API_KEY: 'wrong-provider' }, readFile: absent })).toThrow('OPENCODE_API_KEY');
});

test('очистка повторных и пересекающихся секретов без раскрытия списка', () => {
  const redact = createRedactor(['abc', 'bcd', 'abc', '']);
  expect(redact('abcd abc bcd')).toBe('[REDACTED] [REDACTED] [REDACTED]');
  expect(createRedactor([])('plain')).toBe('plain');
});

test('пример окружения соответствует выбранной модели и конфигурации', () => {
  const example = readFileSync('.env.example', 'utf8')
    .replace('replace-with-vk-community-token', valid.VK_TOKEN)
    .replace('replace-with-opencode-api-key', valid.OPENCODE_API_KEY);
  const { config } = loadConfig({ env: {}, readFile: () => example });
  expect(config.llm.provider).toBe('opencode');
  expect(config.llm.model).toBe('deepseek-v4.1-flash');
  expect(config.vk.token).toBe(valid.VK_TOKEN);
  expect(config.llm.apiKey).toBe(valid.OPENCODE_API_KEY);
});
