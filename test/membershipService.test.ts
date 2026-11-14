import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatMembershipStats,
  type MembershipStats,
} from '../src/services/membership/membershipService.js';

function stats(overrides: Partial<MembershipStats> = {}): MembershipStats {
  const from = new Date('2026-10-15T09:00:00.000Z');
  const to = new Date('2026-11-14T09:00:00.000Z');
  return {
    current: 42,
    currentSource: 'vk',
    joined: 7,
    left: 3,
    net: 4,
    uniqueMembers: 6,
    returningMembers: 1,
    repeatJoins: 1,
    period: { from, to, days: 30 },
    trackingSince: new Date('2026-11-14T09:00:00.000Z'),
    timeZone: 'Europe/Moscow',
    partial: false,
    ...overrides,
  };
}

test('formatMembershipStats returns the aggregate report', () => {
  assert.equal(
    formatMembershipStats(stats()),
    [
      '📊 Участники за 30 дней',
      'Сейчас: 42',
      'Вошло: 7',
      'Вышло: 3',
      'Прирост: +4',
      'Уникальных участников: 6',
      'Повторных входов: 1',
    ].join('\n'),
  );
});

test('formatMembershipStats uses Russian day forms', () => {
  const cases: Array<[number, string]> = [
    [1, '1 день'],
    [2, '2 дня'],
    [4, '4 дня'],
    [5, '5 дней'],
    [11, '11 дней'],
    [21, '21 день'],
    [22, '22 дня'],
    [25, '25 дней'],
    [30, '30 дней'],
  ];
  for (const [days, label] of cases) {
    const report = formatMembershipStats(stats({ period: { ...stats().period, days } }));
    assert.equal(report.split('\n')[0], `📊 Участники за ${label}`);
  }
});

test('formatMembershipStats explains partial tracking and database fallback', () => {
  const report = formatMembershipStats(
    stats({
      currentSource: 'db',
      joined: 0,
      left: 0,
      net: 0,
      uniqueMembers: 0,
      returningMembers: 0,
      repeatJoins: 0,
      partial: true,
      trackingSince: new Date('2026-11-14T09:00:00.000Z'),
    }),
  );
  assert.match(report, /Учёт ведётся с 14\.11\.2026\./u);
  assert.match(report, /VK недоступен/u);
  assert.match(report, /входов и выходов не было/u);
});

test('formatMembershipStats shows a negative net without a plus sign', () => {
  const report = formatMembershipStats(stats({ joined: 2, left: 5, net: -3 }));
  assert.match(report, /Прирост: -3/u);
});
