import { expect, test } from 'vitest';
import { extractReminderTime, resolveReminderTime } from '../src/core/reminders/time';

function resolve(text: string, origin: string, timezone?: string) {
  return resolveReminderTime({
    ...extractReminderTime(text),
    originAt: Date.parse(origin),
    ...(timezone === undefined ? {} : { timezone }),
  });
}

test('относительный срок идёт от исходного сообщения, а в подтверждении доступен UTC', () => {
  const origin = '2026-11-23T19:00:00Z';
  const processedAt = Date.parse('2026-11-23T19:03:00Z');
  const time = resolve('через 20 минут взять документы', origin);
  expect(time).toEqual({
    kind: 'scheduled',
    dueAt: Date.parse('2026-11-23T19:20:00Z'),
    timezone: 'UTC',
  });
  if (time.kind === 'scheduled') expect(time.dueAt - processedAt).toBe(17 * 60_000);
});

test.each([
  ['завтра в 18:00 по Москве', '2026-11-23T20:55:00Z', '2026-11-24T15:00:00Z'],
  ['завтра в 00:00 Europe/Moscow', '2026-11-30T20:55:00Z', '2026-11-30T21:00:00Z'],
  ['1.1 в 18:00 Asia/Tokyo', '2026-01-01T00:00:00Z', '2026-01-01T09:00:00Z'],
])('дата %s рассчитывается по явному поясу', (text, origin, due) => {
  expect(resolve(text, origin, 'America/New_York')).toMatchObject({
    kind: 'scheduled',
    dueAt: Date.parse(due),
  });
});

test('без личной зоны и при разговорном времени требуется уточнение', () => {
  expect(resolve('завтра в 18:00', '2026-11-23T20:55:00Z')).toEqual({ kind: 'zone' });
  expect(resolve('завтра вечером взять документы', '2026-11-23T20:55:00Z', 'UTC')).toEqual({
    kind: 'time',
  });
  expect(extractReminderTime('завтра вечером взять документы')).toMatchObject({
    date: 'завтра',
    content: 'взять документы',
  });
});

test('весенний пропуск и осенний повтор часа требуют выбора', () => {
  expect(resolve('завтра в 02:30', '2026-03-28T20:55:00Z', 'Europe/Berlin')).toEqual({
    kind: 'skipped',
  });
  expect(resolve('завтра в 02:30', '2026-10-24T20:55:00Z', 'Europe/Berlin')).toEqual({
    kind: 'overlap',
    choices: [Date.parse('2026-10-25T00:30:00Z'), Date.parse('2026-10-25T01:30:00Z')],
    timezone: 'Europe/Berlin',
  });
});

test('день и часы могут стоять по разные стороны поручения', () => {
  for (const input of [
    'завтра забрать 2 посылки в 18:00 по Москве',
    'завтра в 18:00 по Москве забрать 2 посылки',
    'в 18:00 забрать 2 посылки завтра по Москве',
  ]) {
    expect(extractReminderTime(input).content).toBe('забрать 2 посылки');
    expect(resolve(input, '2026-11-25T12:00:00Z')).toMatchObject({
      kind: 'scheduled',
      dueAt: Date.UTC(2026, 10, 26, 15),
    });
  }
});

test('составная длительность и взаимоисключающие варианты', () => {
  expect(extractReminderTime('через 1 час 30 минут забрать 2 посылки')).toMatchObject({
    schedule: { kind: 'relative', minutes: 90 },
    content: 'забрать 2 посылки',
  });
  expect(extractReminderTime('через 1 час или через 2 часа забрать посылку')).toMatchObject({
    schedule: undefined,
    timeExample: 'через 2 часа',
    content: 'забрать посылку',
  });
  for (const input of [
    '1 час и ещё немного',
    '1 час и ещё несколько минут',
    '1 час, несколько минут',
    '1 час и ещё пару минут',
    '1 час с половиной',
    '1 час 2 секунды',
    '1 час или полчаса',
    '1 час или через 2',
    'час или через 2 часа',
    '1 час или через месяц',
    '1 час 2 месяца',
  ])
    expect(extractReminderTime('через ' + input + ' забрать посылку')).toMatchObject({
      schedule: undefined,
      ambiguous: true,
      content: 'забрать посылку',
    });
  expect(extractReminderTime('в 18:00 или 19:00 забрать посылку')).toMatchObject({
    schedule: undefined,
    ambiguous: true,
    content: 'забрать посылку',
  });
  expect(extractReminderTime('в 18:00 или вечером забрать посылку')).toMatchObject({
    schedule: undefined,
    ambiguous: true,
    content: 'забрать посылку',
  });
});

test.each(['1 час и 30', '1 час 30', '1 час, ещё 30', '1 час и 30 и 10 минут'])(
  'неполная длительность «%s» отделяется от поручения целиком',
  (duration) => {
    expect(extractReminderTime(`через ${duration} забрать посылку`)).toMatchObject({
      schedule: undefined,
      ambiguous: true,
      timeExample: 'через 1 час 30 минут',
      content: 'забрать посылку',
    });
  },
);

test.each([
  ['через 1 час 30 мин забрать билет', 90, 'забрать билет'],
  ['забрать через 1 час 30 мин. билет', 90, 'забрать билет'],
  ['через 1 час, 30 минут забрать посылку', 90, 'забрать посылку'],
  ['через 1 час забрать 30 посылок', 60, 'забрать 30 посылок'],
  ['через 1 час: 30 посылок забрать', 60, '30 посылок забрать'],
  ['через 1 час пронести посылку через 3 коридора', 60, 'пронести посылку через 3 коридора'],
])('расчёт срока и сохранение поручения для «%s»', (request, minutes, content) => {
  const origin = '2026-11-25T12:00:00Z';
  expect(extractReminderTime(request)).toMatchObject({
    schedule: { kind: 'relative', minutes },
    ambiguous: false,
    content,
  });
  expect(resolve(request, origin)).toEqual({
    kind: 'scheduled',
    dueAt: Date.parse(origin) + minutes * 60_000,
    timezone: 'UTC',
  });
});

test('отдельная числовая дата и перечисление через запятую сохраняют поручение', () => {
  for (const input of [
    '27.11.2026 забрать 2 посылки в 18:00 по Москве',
    '27.11.2026 в 18:00 по Москве забрать 2 посылки',
    'в 18:00 забрать 2 посылки 27.11.2026 по Москве',
  ]) {
    expect(extractReminderTime(input).content).toBe('забрать 2 посылки');
    expect(resolve(input, '2026-11-25T12:00:00Z')).toMatchObject({
      kind: 'scheduled',
      dueAt: Date.UTC(2026, 10, 27, 15),
    });
  }
  expect(extractReminderTime('через 1 час, 30 минут забрать 2 посылки')).toMatchObject({
    schedule: { kind: 'relative', minutes: 90 },
    content: 'забрать 2 посылки',
  });
  expect(extractReminderTime('через 1 час, ещё 30 минут обновить версию 3.14')).toMatchObject({
    schedule: { kind: 'relative', minutes: 90 },
    content: 'обновить версию 3.14',
  });
  expect(extractReminderTime('27.11.2026 проверить версию 2.10 в 18:00')).toMatchObject({
    schedule: { kind: 'local', date: '27.11.2026', hour: 18, minute: 0 },
    content: 'проверить версию 2.10',
  });
});
