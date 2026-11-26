import { expect, test } from 'vitest';
import { parseRecapPeriod, recapClarification } from '../src/core/chat-summaries/recap-period';

const zone = 'Europe/Moscow';
const at = Date.UTC(2026, 10, 24, 22); // Уже 25 ноября в беседе.
const expected = {
  kind: 'period',
  period: { from: Date.UTC(2026, 10, 19, 21), to: Date.UTC(2026, 10, 22, 21), timezone: zone },
};
test.each([
  'с двадцатого по двадцать второе ноября',
  '20–22 ноября',
  'с 20-го по двадцать второе ноября',
  '20.11.2026–22.11.2026',
  '2026-11-20 — 2026-11-22',
])('одни местные дни для «%s»', (phrase) => {
  expect(parseRecapPeriod('Пенёк, что обсуждали ' + phrase + '?', at, zone)).toEqual(expected);
  expect(parseRecapPeriod(phrase, at, zone)).toEqual(expected);
});
test('неполные границы сохраняются в UTC, новый интервал может заменить их', () => {
  const start = parseRecapPeriod('с двадцатого ноября', at, zone);
  expect(start).toEqual({ kind: 'clarify', known: { from: expected.period.from } });
  if (start.kind !== 'clarify') throw new Error('Ожидалось уточнение');
  expect(parseRecapPeriod('по 22-е', at, zone, start.known)).toEqual(expected);
  expect(parseRecapPeriod('первое — второе ноября', at, zone, start.known)).toEqual({
    kind: 'period',
    period: { from: Date.UTC(2026, 9, 31, 21), to: Date.UTC(2026, 10, 2, 21), timezone: zone },
  });
  expect(parseRecapPeriod('до 22 ноября', at, zone)).toEqual({
    kind: 'clarify',
    known: { to: expected.period.to },
  });
});
test('относительный день, точное время и переход между месяцами', () => {
  expect(parseRecapPeriod('вчера', at, zone)).toEqual({
    kind: 'period',
    period: { from: Date.UTC(2026, 10, 23, 21), to: Date.UTC(2026, 10, 24, 21), timezone: zone },
  });
  expect(parseRecapPeriod('вчера с 10:00 до 11:00', at, zone)).toEqual({
    kind: 'period',
    period: { from: Date.UTC(2026, 10, 24, 7), to: Date.UTC(2026, 10, 24, 8), timezone: zone },
  });
  expect(parseRecapPeriod('с 30 ноября по 2 декабря 2026', at, zone)).toEqual({
    kind: 'period',
    period: { from: Date.UTC(2026, 10, 29, 21), to: Date.UTC(2026, 11, 2, 21), timezone: zone },
  });
  for (const phrase of [
    '31 ноября',
    '20–22',
    'вчера или сегодня',
    'вчера вечером',
    '29.02.2025',
    '22 ноября — 20 ноября',
  ])
    expect(parseRecapPeriod(phrase, at, zone).kind, phrase).toBe('clarify');
});

test('в ответ на уточнение достаточно месяца или года', () => {
  const days = parseRecapPeriod('с двадцатого по двадцать второе', at, zone);
  if (days.kind !== 'clarify') throw Error('Ожидался месяц');
  expect(parseRecapPeriod('в ноябре', at, zone, days.known)).toEqual(expected);
  const otherMonth = parseRecapPeriod('с 20 по 22 октября', at, zone);
  if (otherMonth.kind !== 'clarify') throw Error('Ожидался год');
  expect(parseRecapPeriod('2025 год', at, zone, otherMonth.known)).toEqual({
    kind: 'period',
    period: { from: Date.UTC(2025, 9, 19, 21), to: Date.UTC(2025, 9, 22, 21), timezone: zone },
  });
});

test('при известном дне уточняются только часы, новый полный период заменяет исходный', () => {
  for (const direction of ['после', 'до']) {
    const pending = parseRecapPeriod('вчера ' + direction + ' обеда', at, zone);
    if (pending.kind !== 'clarify') throw Error('Ожидалось уточнение часов');
    expect(recapClarification(pending.known, at)).toContain(
      'какого времени вчера собрать пересказ?',
    );
    expect(pending.known.calendar).toEqual({ day: '2026-11-24', timezone: zone, direction });
    expect(parseRecapPeriod('28:90', at, zone, pending.known)).toEqual(pending);
    expect(parseRecapPeriod('18:00', at + 86400000, 'UTC', pending.known)).toEqual(
      parseRecapPeriod('вчера ' + direction + ' 18:00', at, zone),
    );
    expect(parseRecapPeriod('20–22 ноября', at, zone, pending.known)).toEqual(expected);
  }
});

test('короткий интервал и ответ о конце используют две границы исходного дня', () => {
  const result = parseRecapPeriod('вчера с 18:00 до 20:00', at, zone);
  for (const day of ['вчера', '24.11.2026', '2026-11-24']) {
    expect(parseRecapPeriod(day + ' 18:00–20:00? ', at, zone)).toEqual(result);
  }
  const pending = parseRecapPeriod('вчера 18:00–?', at, zone);
  expect(pending).toEqual({
    kind: 'clarify',
    known: {
      from: Date.UTC(2026, 10, 24, 15),
      calendar: { direction: 'конец', day: '2026-11-24', timezone: zone },
    },
  });
  if (pending.kind !== 'clarify') throw Error('Ожидался вопрос о конце');
  expect(recapClarification(pending.known, at)).toContain('До какого времени');
  for (const invalid of ['18:00', '16:00', '27:61']) {
    expect(parseRecapPeriod(invalid, at, zone, pending.known)).toEqual(pending);
  }
  expect(parseRecapPeriod('20:00', at + 86400000, 'UTC', pending.known)).toEqual(result);
  const replacement = '24.11.2026 с 08:00 до 09:00';
  expect(parseRecapPeriod(replacement, at, zone, pending.known)).toEqual(
    parseRecapPeriod(replacement, at, zone),
  );
  expect(parseRecapPeriod('вчера 18:00–20:99', at, zone).kind).toBe('clarify');
});

test('обе односторонние границы строги и ограничены выбранным местным днём', () => {
  const day = Date.UTC(2026, 10, 23, 21);
  const end = Date.UTC(2026, 10, 24, 21);
  const six = Date.UTC(2026, 10, 24, 15);
  for (const [phrase, from, to] of [
    ['вчера до полудня', day, Date.UTC(2026, 10, 24, 9)],
    ['вчера после 18:00', six + 1, end],
    ['вчера до 18:00', day, six],
    ['вчера после 00:00', day + 1, end],
    ['вчера до 00:00', day, day],
  ] as const)
    expect(parseRecapPeriod(phrase, at, zone)).toEqual({
      kind: 'period',
      period: { from, to, timezone: zone },
    });
});
