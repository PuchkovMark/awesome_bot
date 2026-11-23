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
