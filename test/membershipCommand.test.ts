import assert from 'node:assert/strict';
import { test } from 'node:test';
import commandService, { isBotAdminCommand } from '../src/services/command/commandService.js';
import { normalizeCommandName } from '../src/services/command/commandAliases.js';
import membershipService, {
  type MembershipStats,
} from '../src/services/membership/membershipService.js';

const membershipStats: MembershipStats = {
  current: 42,
  currentSource: 'vk',
  joined: 7,
  left: 3,
  net: 4,
  uniqueMembers: 6,
  returningMembers: 1,
  repeatJoins: 1,
  period: {
    from: new Date('2026-11-07T09:00:00.000Z'),
    to: new Date('2026-11-14T09:00:00.000Z'),
    days: 7,
  },
  trackingSince: new Date('2026-11-14T09:00:00.000Z'),
  timeZone: 'Europe/Moscow',
  partial: false,
};

test('membership command aliases normalize to membership', () => {
  assert.equal(normalizeCommandName('membership'), 'membership');
  assert.equal(normalizeCommandName('участники'), 'membership');
  assert.equal(normalizeCommandName('состав'), 'membership');
  assert.equal(normalizeCommandName('статистикаучастников'), 'membership');
  assert.equal(isBotAdminCommand('membership'), true);
  assert.equal(isBotAdminCommand('участники'), true);
});

test('membership command is denied to non-admin participants', async () => {
  const result = await commandService.handleCommand(
    'участники',
    '',
    '2000000001',
    '123',
    false,
    false,
    false,
    true,
  );
  assert.equal(result, 'Эта команда доступна только администраторам бота.');
});

test('membership command is not available in a direct dialog', async () => {
  const result = await commandService.handleCommand(
    'membership',
    '',
    '1',
    '123',
    true,
    false,
    false,
    false,
  );
  assert.equal(result, 'Статистика участников доступна только в групповой беседе.');
});

test('membership command validates the period', async () => {
  const result = await commandService.handleCommand(
    'membership',
    'abc',
    '2000000001',
    '123',
    true,
    false,
    false,
    true,
  );
  assert.match(result ?? '', /Укажите период от 1 до 3650 дней/u);

  const tooLong = await commandService.handleCommand(
    'membership',
    '3651',
    '2000000001',
    '123',
    true,
    false,
    false,
    true,
  );
  assert.match(tooLong ?? '', /Укажите период от 1 до 3650 дней/u);
});

test('membership command formats aggregates for a bot admin', async (t) => {
  t.mock.method(membershipService, 'getStats', async () => membershipStats);
  const result = await commandService.handleCommand(
    'membership',
    '7',
    '2000000001',
    '123',
    true,
    false,
    false,
    true,
  );
  assert.match(result ?? '', /Участники за 7 дней/u);
  assert.match(result ?? '', /Сейчас: 42/u);
  assert.match(result ?? '', /Прирост: \+4/u);
  assert.match(result ?? '', /Повторных входов: 1/u);
});
