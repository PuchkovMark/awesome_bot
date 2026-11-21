import { expect, test } from 'vitest';
import { compositeId, databasePath, timestamp, timezone } from '../src/storage/validation.js';

for (const value of ['', 'relative.sqlite', undefined, 42]) {
  test(`неверный путь ${String(value)}`, () => expect(() => databasePath(value)).toThrow('invalid_input'));
}
for (const value of ['', 'id', ':local', 'vk:', null]) {
  test(`неверный составной id ${String(value)}`, () => expect(() => compositeId(value)).toThrow('invalid_input'));
}
for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0']) {
  test(`неверное время ${String(value)}`, () => expect(() => timestamp(value)).toThrow('invalid_input'));
}
test('допустимые нейтральные значения и IANA-таймзона', () => {
  compositeId('vk:-1'); timestamp(0); databasePath(':memory:'); timezone('Europe/Moscow');
  expect(() => timezone('not/a/timezone')).toThrow('invalid_input');
});
