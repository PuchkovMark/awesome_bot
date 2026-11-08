import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_REMINDER_TIME_ZONE,
  getNextRecurringDate,
  resolveReminderTimeZone,
  toUtcDateTime,
  type RecurrenceRule,
} from '../src/services/reminders/reminderDateTime.js';
import { parseReminder } from '../src/services/reminders/reminderParser.js';

const now = new Date('2026-03-28T12:00:00.000Z');
const timeZone = 'Europe/Moscow';

test('reminders default to Moscow time unless a valid configured zone is available', () => {
  assert.equal(resolveReminderTimeZone(null, null), 'Europe/Moscow');
  assert.equal(resolveReminderTimeZone('invalid/zone', null), DEFAULT_REMINDER_TIME_ZONE);
  assert.equal(resolveReminderTimeZone(null, 'Europe/Paris'), 'Europe/Paris');
  assert.equal(resolveReminderTimeZone('Asia/Tokyo', 'Europe/Paris'), 'Asia/Tokyo');
  assert.equal(
    toUtcDateTime(
      { date: '2026-03-29', time: '10:00' },
      resolveReminderTimeZone(null, null),
    ).toISOString(),
    '2026-03-29T07:00:00.000Z',
  );
});

test('parses a one-time reminder with a date, time, and content', () => {
  const parsed = parseReminder('Пенёк, напомни завтра в 10:00 позвонить мастеру.', now, timeZone);

  assert.equal(parsed.missing, null);
  assert.equal(parsed.content, 'позвонить мастеру');
  assert.equal(parsed.dueAt?.toISOString(), '2026-03-29T07:00:00.000Z');
});

test('parses relative reminders and preserves their requested interval', () => {
  const parsed = parseReminder('Напомни через два часа проверить документы', now, timeZone);

  assert.equal(parsed.missing, null);
  assert.equal(parsed.content, 'проверить документы');
  assert.equal(parsed.dueAt?.toISOString(), '2026-03-28T14:00:00.000Z');
});

test('asks for an unambiguous time when the request contains only an hour', () => {
  const parsed = parseReminder('Напомни завтра в 10 позвонить мастеру', now, timeZone);

  assert.equal(parsed.missing, 'time');
  assert.equal(parsed.ambiguousTime, true);
});

test('parses weekly recurrence and shared delivery intent', () => {
  const parsed = parseReminder(
    'Пенёк, напоминай всем каждую пятницу в 18:00 оплатить счета',
    now,
    timeZone,
  );

  assert.equal(parsed.missing, null);
  assert.equal(parsed.groupRequested, true);
  assert.deepEqual(parsed.recurrence, { type: 'weekly', weekdays: [5] });
  assert.equal(parsed.content, 'оплатить счета');
  assert.equal(parsed.dueAt?.toISOString(), '2026-04-03T15:00:00.000Z');
});

test('parses interval recurrence without inventing a clock time', () => {
  const parsed = parseReminder('Каждые три дня напоминай проверять почту', now, timeZone);

  assert.equal(parsed.missing, null);
  assert.deepEqual(parsed.recurrence, { type: 'interval', intervalMs: 3 * 86_400_000 });
  assert.equal(parsed.content, 'проверять почту');
  assert.equal(parsed.dueAt?.toISOString(), '2026-03-31T12:00:00.000Z');
});

test('requires a date for monthly recurrence when no day is specified', () => {
  const parsed = parseReminder('Ежемесячно в 9 утра напоминай проверить платежи', now, timeZone);

  assert.equal(parsed.missing, 'date');
  assert.equal(parsed.content, 'проверить платежи');
  assert.equal(parsed.dueAt, undefined);
});

test('parses the first day of each month and yearly dates', () => {
  const monthly = parseReminder(
    'Напоминай первого числа каждого месяца в 9 утра проверять платежи',
    now,
    timeZone,
  );
  const yearly = parseReminder('Каждый год 1 октября в 9:00 поздравить маму', now, timeZone);

  assert.equal(monthly.missing, null);
  assert.deepEqual(monthly.recurrence, { type: 'monthly', day: 1 });
  assert.equal(monthly.content, 'проверять платежи');
  assert.equal(yearly.missing, null);
  assert.deepEqual(yearly.recurrence, { type: 'yearly', month: 10, day: 1 });
  assert.equal(yearly.content, 'поздравить маму');
});

test('resolves daylight-saving gaps and calendar-end recurrence dates', () => {
  const shifted = toUtcDateTime({ date: '2026-03-29', time: '02:30' }, 'Europe/Berlin');
  assert.equal(shifted.toISOString(), '2026-03-29T01:30:00.000Z');

  const rule: RecurrenceRule = { type: 'monthly', day: 31 };
  const next = getNextRecurringDate(new Date('2026-04-01T00:00:00.000Z'), 'UTC', '09:00', rule);
  assert.equal(next.toISOString(), '2026-04-30T09:00:00.000Z');

  const leapYearRule: RecurrenceRule = { type: 'yearly', month: 2, day: 29 };
  const leapYearOccurrence = getNextRecurringDate(
    new Date('2025-03-01T00:00:00.000Z'),
    'UTC',
    '09:00',
    leapYearRule,
  );
  assert.equal(leapYearOccurrence.toISOString(), '2026-02-28T09:00:00.000Z');
});
