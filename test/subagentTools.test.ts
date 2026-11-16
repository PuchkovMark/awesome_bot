import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AIProvider } from '../src/services/ai/AIProvider.js';
import type { HistoryMessage } from '../src/services/ai/chatDigestService.js';
import { createSubagentTools } from '../src/services/ai/tools/subagentTools.js';

const baseTime = new Date('2026-11-14T10:00:00.000Z').getTime();

function message(index: number, text: string): HistoryMessage {
  return {
    dbId: `m${index}`,
    timestamp: baseTime + index * 60_000,
    author: 'Иван',
    role: 'user',
    text,
    attachments: [],
  };
}

function mockProvider(calls: unknown[] = []): AIProvider {
  return {
    name: 'mock',
    async send(_messages, options) {
      calls.push(options);
      return {
        content: JSON.stringify({
          from: '2026-11-14T10:00:00.000Z',
          to: '2026-11-14T10:05:00.000Z',
          message_count: 5,
          topics: ['ремонт'],
          decisions: ['начать в субботу'],
          questions: [],
          agreements: [],
          facts: ['Иван предложил начать в субботу'],
          participants: ['Иван'],
        }),
      };
    },
  };
}

function makeTools(active = true, calls: unknown[] = []) {
  const messages = [
    message(1, 'Привет, обсудим ремонт'),
    message(2, 'Я за субботу'),
    message(3, 'Кто купит краску?'),
    message(4, 'Ремонт начнём утром'),
    message(5, 'Краску купит Иван'),
  ];
  const tools = createSubagentTools({
    messages,
    task: 'Перескажи обсуждение ремонта',
    timeZone: 'Europe/Moscow',
    isChat: true,
    seenMessageIds: new Set<string>(),
    provider: mockProvider(calls),
    limiter: (fn) => fn(),
    isActive: () => active,
  });
  return tools;
}

test('subagent pager returns pages and advances with next_before', async () => {
  const tools = makeTools();
  const pager = tools.find((tool) => tool.name === 'get_local_chat_history');
  assert.ok(pager);
  const first = JSON.parse(await pager.execute({ limit: 2 }));
  assert.equal(first.status, 'partial');
  assert.equal(first.returned, 2);
  assert.deepEqual(
    first.messages.map((item: { text: string }) => item.text),
    ['Ремонт начнём утром', 'Краску купит Иван'],
  );
  assert.ok(first.next_before);

  const second = JSON.parse(await pager.execute({ before: first.next_before, limit: 2 }));
  assert.equal(second.returned, 2);
  assert.notEqual(second.messages[0]?.text, first.messages[0]?.text);
});

test('subagent search is case-insensitive and reports totals', async () => {
  const tools = makeTools();
  const search = tools.find((tool) => tool.name === 'search_history');
  assert.ok(search);
  const result = JSON.parse(await search.execute({ query: 'РЕМОНТ' }));
  assert.equal(result.status, 'result');
  assert.equal(result.total_matches, 2);
  assert.equal(result.returned, 2);
});

test('subagent history exposes message ids and reply targets', async () => {
  const messages: HistoryMessage[] = [
    { ...message(1, 'Исходное сообщение'), conversationMessageId: 10 },
    {
      ...message(2, 'Ответ на исходное'),
      conversationMessageId: 11,
      replyToConversationMessageId: 10,
      replyToAuthor: 'Иван',
      replyToText: 'Исходное сообщение',
    },
  ];
  const tools = createSubagentTools({
    messages,
    task: 'Проверь ответы',
    timeZone: 'Europe/Moscow',
    isChat: true,
    seenMessageIds: new Set<string>(),
    provider: mockProvider(),
    limiter: (fn) => fn(),
    isActive: () => true,
  });
  const pager = tools.find((tool) => tool.name === 'get_local_chat_history');
  assert.ok(pager);
  const page = JSON.parse(await pager.execute({ limit: 10 }));
  assert.deepEqual(
    page.messages.find((item: { message_id?: number }) => item.message_id === 11)?.reply_to,
    {
      message_id: 10,
      author: 'Иван',
      text: 'Исходное сообщение',
    },
  );

  const search = tools.find((tool) => tool.name === 'search_history');
  assert.ok(search);
  const found = JSON.parse(await search.execute({ query: 'Ответ на исходное' }));
  assert.equal(found.matches[0]?.message_id, 11);
  assert.deepEqual(found.matches[0]?.reply_to, {
    message_id: 10,
    author: 'Иван',
    text: 'Исходное сообщение',
  });
});

test('subagent summarize returns a compressed overview', async () => {
  const calls: unknown[] = [];
  const tools = makeTools(true, calls);
  const summarize = tools.find((tool) => tool.name === 'summarize_history');
  assert.ok(summarize);
  const result = JSON.parse(
    await summarize.execute({ focus: 'Найди решения по ремонту', max_chars: 5_000 }),
  );
  assert.equal(result.status, 'result');
  assert.equal(result.messages, 5);
  assert.match(result.text, /Темы/u);
  assert.equal(calls.length, 1);
});

test('subagent summarize respects the call limit and inactive state', async () => {
  const tools = makeTools();
  const summarize = tools.find((tool) => tool.name === 'summarize_history');
  assert.ok(summarize);
  assert.equal(JSON.parse(await summarize.execute({ max_chars: 2_000 })).status, 'result');
  const blocked = JSON.parse(await summarize.execute({ max_chars: 2_000 }));
  assert.equal(blocked.status, 'not_executed');

  const inactive = makeTools(false).find((tool) => tool.name === 'summarize_history');
  assert.ok(inactive);
  const result = JSON.parse(await inactive.execute({ max_chars: 2_000 }));
  assert.equal(result.status, 'not_executed');
});

test('subagent tools include only read-only history helpers and datetime', () => {
  const names = makeTools().map((tool) => tool.name);
  assert.deepEqual(names, [
    'get_local_chat_history',
    'search_history',
    'summarize_history',
    'get_current_datetime',
  ]);
});
