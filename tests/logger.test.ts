import { expect, test, vi } from 'vitest';
import { ConfigError } from '../src/config/errors';
import { createRedactor } from '../src/config/secrets';
import { createLogger, reportConfigError } from '../src/logger/index';
import type { LogEvent } from '../src/logger/types';
import { captureLogs } from './helpers/log-output';

const secret = 'unique-test-api-secret';
const humanText = 'Человек написал приватное сообщение';

test.each([
  ['debug', [20, 30, 40, 50, 60]], ['info', [30, 40, 50, 60]],
  ['warn', [40, 50, 60]], ['error', [50, 60]], ['fatal', [60]], ['silent', []],
] as const)('фильтрация уровня %s', (level, expected) => {
  const output = captureLogs();
  const logger = createLogger({ level, destination: output.destination });
  for (const target of ['debug', 'info', 'warn', 'error', 'fatal'] as const) logger.event({ event: 'config_loaded' }, target);
  expect(output.records().map((record) => record.level)).toEqual(expected);
  for (const record of output.records()) {
    expect(record.time).toBeTypeOf('number');
    expect(Number(record.time)).toBeGreaterThan(0);
    expect(record.event).toBe('config_loaded');
    expect(Object.keys(record).sort()).toEqual(['event', 'level', 'time']);
  }
});

test('очистка секретов из отладочных текстов и ошибок', () => {
  const output = captureLogs();
  const logger = createLogger({ level: 'debug', redact: createRedactor([secret]), additionalSecrets: ['another-secret'], destination: output.destination });
  logger.debugText(`${humanText}: ${secret} ${secret} another-secret`);
  logger.debugError(new Error(`${humanText} ${secret}`, { cause: new Error(`cause ${secret}`) }));
  logger.debugError(`thrown ${secret}`);
  expect(output.records()).toHaveLength(3);
  expect(output.text()).toContain(humanText);
  expect(output.text()).toContain('[REDACTED]');
  expect(output.text()).not.toContain(secret);
  expect(output.text()).not.toContain('another-secret');
  expect(output.records().every((record) => record.level === 20)).toBe(true);
});

test.each(['info', 'warn', 'error', 'fatal', 'silent'] as const)('отладочный текст отсутствует при %s', (level) => {
  const output = captureLogs();
  const logger = createLogger({ level, destination: output.destination });
  logger.debugText(humanText);
  logger.debugError(new Error(humanText));
  expect(output.text()).toBe('');
});

test.each(['info', 'debug'] as const)('обычная ошибка не раскрывает текст при %s', (level) => {
  const output = captureLogs();
  const logger = createLogger({ level, destination: output.destination });
  const error = Object.assign(new Error(`${humanText} ${secret}`), { name: secret, cause: { nested: humanText }, token: secret });
  logger.componentError(error);
  logger.componentError(new TypeError(humanText));
  logger.componentError(new RangeError(humanText));
  logger.componentError(new ConfigError('missing', ['VK_TOKEN']));
  expect(output.records().map((record) => record.category)).toEqual(['unknown', 'type', 'range', 'configuration']);
  expect(output.text()).not.toContain(humanText);
  expect(output.text()).not.toContain(secret);
});

test('посторонние поля и сериализаторы не используются, объект не меняется', () => {
  const output = captureLogs();
  const logger = createLogger({ level: 'debug', destination: output.destination });
  const toJSON = vi.fn(() => ({ secret }));
  const getter = vi.fn(() => secret);
  const event = Object.freeze({ event: 'config_loaded' as const, message: humanText, secret, nested: { toJSON }, toJSON });
  logger.event(event);
  const error = { toJSON, get message() { return getter(); } };
  logger.componentError(error);
  logger.debugError(error);
  logger.event(Object.defineProperty({}, 'event', { get: getter }) as LogEvent);
  expect(toJSON).not.toHaveBeenCalled();
  expect(getter).not.toHaveBeenCalled();
  expect(event.secret).toBe(secret);
  expect(output.text()).not.toContain(secret);
  expect(output.text()).not.toContain(humanText);
});

test('обход типов не позволяет вывести неизвестные коды и параметры', () => {
  const output = captureLogs();
  const logger = createLogger({ destination: output.destination });
  logger.event({ event: secret } as unknown as LogEvent);
  logger.event({ event: 'component_error', category: secret } as unknown as LogEvent);
  logger.event({ event: 'config_invalid', code: secret, parameters: [secret] } as unknown as LogEvent);
  logger.event({ event: 'config_invalid', code: 'missing', parameters: ['VK_TOKEN', secret], nested: { token: secret } } as unknown as LogEvent);
  expect(output.records()).toHaveLength(1);
  expect(output.records()[0]?.parameters).toEqual(['VK_TOKEN']);
  expect(output.text()).not.toContain(secret);
});

test('диагностика конфигурации безопасна без полной конфигурации логгера', () => {
  const output = captureLogs();
  reportConfigError(new ConfigError('missing', ['OPENCODE_API_KEY']), output.destination);
  reportConfigError(Object.assign(new Error(secret), { code: secret, parameters: [secret] }), output.destination);
  expect(output.records().map((record) => record.event)).toEqual(['config_invalid', 'config_invalid']);
  expect(output.records()[0]?.parameters).toEqual(['OPENCODE_API_KEY']);
  expect(output.text()).not.toContain(secret);
});
