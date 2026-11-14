import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { VK } from 'vk-io';
import { createChatInfoTool } from '../src/services/ai/tools/chatInfoTool.js';
import type { MembershipStats } from '../src/services/membership/membershipService.js';

const peerId = 2_000_000_777;

function mockApi(bdate = '01.01') {
  const calls: string[] = [];
  const api = {
    messages: {
      getConversationMembers: async (request: { offset: number; count: number }) => {
        calls.push(`members:${request.offset}:${request.count}`);
        return {
          count: 2,
          items: [
            { member_id: 1, is_admin: true, is_owner: true, join_date: 1_700_000_000 },
            { member_id: 2, is_admin: false, is_owner: false, join_date: 1_700_000_001 },
          ],
          profiles: [
            { id: 1, first_name: 'Иван', last_name: 'Петров', screen_name: 'ivan' },
            { id: 2, first_name: 'Мария', last_name: 'Сидорова', screen_name: 'maria' },
          ],
          groups: [],
        };
      },
      getConversationsById: async () => ({ items: [] }),
    },
    call: async (method: string) => {
      calls.push(method);
      if (method === 'users.get') {
        return [
          { id: 1, first_name: 'Иван', last_name: 'Петров', bdate, city: { title: 'Москва' } },
          { id: 2, first_name: 'Мария', last_name: 'Сидорова', bdate: '02.01' },
        ];
      }
      return [];
    },
  } as unknown as VK['api'];
  return { api, calls };
}

const allowed = async () => ({ allowed: true as const, isAdmin: false });
const noop = () => {
  // No-op for tests.
};

test('get_chat_info members returns 50-max pages with fields and hidden fields', async () => {
  const { api } = mockApi();
  const tool = createChatInfoTool({
    api,
    peerId,
    senderId: '1',
    isChat: true,
    checkAccess: allowed,
    onInfoReturned: noop,
  });
  const result = JSON.parse(await tool.execute({ action: 'members', offset: 0, count: 50 }));
  assert.equal(result.status, 'result');
  assert.equal(result.action, 'members');
  assert.equal(result.total, 2);
  assert.equal(result.members.length, 2);
  assert.equal(result.members[0].fields.bdate, '01.01');
  assert.ok(result.members[0].hidden_fields.includes('about'));
  assert.equal(result.has_more, false);
});

test('get_chat_info birthdays returns upcoming birthdays for the chat', async () => {
  const { api } = mockApi('01.01');
  const tool = createChatInfoTool({
    api,
    peerId: peerId + 1,
    senderId: '1',
    isChat: true,
    timeZone: 'Europe/Moscow',
    checkAccess: allowed,
    onInfoReturned: noop,
  });
  const result = JSON.parse(await tool.execute({ action: 'birthdays', days: 366, count: 50 }));
  assert.equal(result.status, 'result');
  assert.equal(result.action, 'birthdays');
  assert.equal(result.scope, 'chat');
  assert.ok(Array.isArray(result.items));
  assert.ok(result.items.length >= 1);
  assert.equal(typeof result.items[0].days_left, 'number');
});

test('get_chat_info in a direct dialog exposes only own birthdays', async () => {
  const { api } = mockApi('01.01');
  const tool = createChatInfoTool({
    api,
    peerId: 1,
    senderId: '1',
    isChat: false,
    timeZone: 'Europe/Moscow',
    checkAccess: allowed,
    onInfoReturned: noop,
  });
  const members = JSON.parse(await tool.execute({ action: 'members' }));
  assert.equal(members.status, 'not_applicable');

  const birthdays = JSON.parse(await tool.execute({ action: 'birthdays', days: 366, count: 50 }));
  assert.equal(birthdays.status, 'result');
  assert.equal(birthdays.scope, 'direct');
  assert.ok(birthdays.items.length <= 1);
});

test('get_chat_info denies access before fetching VK data', async () => {
  const { api, calls } = mockApi();
  const tool = createChatInfoTool({
    api,
    peerId: peerId + 2,
    senderId: '1',
    isChat: true,
    checkAccess: async () => ({ allowed: false, message: 'Нет доступа' }),
    onInfoReturned: noop,
  });
  const result = JSON.parse(await tool.execute({ action: 'overview' }));
  assert.equal(result.status, 'not_executed');
  assert.equal(calls.length, 0);
});

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
    from: new Date('2026-10-15T09:00:00.000Z'),
    to: new Date('2026-11-14T09:00:00.000Z'),
    days: 30,
  },
  trackingSince: new Date('2026-11-14T09:00:00.000Z'),
  timeZone: 'Europe/Moscow',
  partial: false,
};

test('get_chat_info membership returns aggregates for a bot admin', async () => {
  const { api, calls } = mockApi();
  let days = 0;
  const tool = createChatInfoTool({
    api,
    peerId: peerId + 3,
    senderId: '1',
    isChat: true,
    checkAccess: async () => ({ allowed: true, isAdmin: true }),
    onInfoReturned: noop,
    getMembershipStats: async (input) => {
      days = input.days;
      return membershipStats;
    },
  });
  const result = JSON.parse(await tool.execute({ action: 'membership', days: 7 }));
  assert.equal(days, 7);
  assert.equal(calls.length, 0);
  assert.equal(result.status, 'result');
  assert.equal(result.action, 'membership');
  assert.equal(result.current, 42);
  assert.equal(result.current_source, 'vk');
  assert.equal(result.joined, 7);
  assert.equal(result.left, 3);
  assert.equal(result.net, 4);
  assert.equal(result.unique_members, 6);
  assert.equal(result.returning_members, 1);
  assert.equal(result.repeat_joins, 1);
  assert.equal(result.partial, false);
});

test('get_chat_info membership is denied to non-admin participants', async () => {
  const { api } = mockApi();
  let called = false;
  const tool = createChatInfoTool({
    api,
    peerId: peerId + 4,
    senderId: '1',
    isChat: true,
    checkAccess: async () => ({ allowed: true, isAdmin: false }),
    onInfoReturned: noop,
    getMembershipStats: async () => {
      called = true;
      return membershipStats;
    },
  });
  const result = JSON.parse(await tool.execute({ action: 'membership' }));
  assert.equal(result.status, 'not_executed');
  assert.equal(called, false);
});

test('get_chat_info membership is not applicable in a direct dialog', async () => {
  const { api } = mockApi();
  let called = false;
  const tool = createChatInfoTool({
    api,
    peerId: 1,
    senderId: '1',
    isChat: false,
    checkAccess: async () => ({ allowed: true, isAdmin: true }),
    onInfoReturned: noop,
    getMembershipStats: async () => {
      called = true;
      return membershipStats;
    },
  });
  const result = JSON.parse(await tool.execute({ action: 'membership' }));
  assert.equal(result.status, 'not_applicable');
  assert.equal(called, false);
});

test('get_chat_info membership rejects an invalid period', async () => {
  const { api } = mockApi();
  let called = false;
  const tool = createChatInfoTool({
    api,
    peerId: peerId + 5,
    senderId: '1',
    isChat: true,
    checkAccess: async () => ({ allowed: true, isAdmin: true }),
    onInfoReturned: noop,
    getMembershipStats: async () => {
      called = true;
      return membershipStats;
    },
  });
  const tooLong = JSON.parse(await tool.execute({ action: 'membership', days: 3651 }));
  assert.equal(tooLong.status, 'not_executed');
  assert.equal(called, false);

  const wrongAction = JSON.parse(await tool.execute({ action: 'overview', days: 30 }));
  assert.equal(wrongAction.status, 'not_executed');
});
