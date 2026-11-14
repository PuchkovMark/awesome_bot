import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalChatHistoryTool } from '../src/services/ai/tools/localChatHistoryTool.js';

type TestMessage = {
  id: string;
  role: string;
  content: string;
  createdAt: Date;
  sentAt: Date | null;
  speaker: string;
  replyToAuthorName: string | null;
  replyToText: string | null;
  attachments: string[];
};

type Access = { allowed: true } | { allowed: false; message: string };

const BASE_TIME = new Date('2026-11-14T10:00:00.000Z');

function message(index: number, overrides: Partial<TestMessage> = {}): TestMessage {
  return {
    id: `m${index}`,
    role: 'user',
    content: `сообщение ${index}`,
    createdAt: new Date(BASE_TIME.getTime() - index * 60_000),
    sentAt: null,
    speaker: `Участник ${index}`,
    replyToAuthorName: null,
    replyToText: null,
    attachments: [],
    ...overrides,
  };
}

function createStore(messages: TestMessage[]) {
  const requests: Array<{ before: Date; from?: Date; limit: number; excludeIds: string[] }> = [];
  return {
    requests,
    async getMessages(input: { before: Date; from?: Date; limit: number; excludeIds: string[] }) {
      requests.push(input);
      const excluded = new Set(input.excludeIds);
      const filtered = messages
        .filter((item) => item.createdAt <= input.before)
        .filter((item) => !input.from || item.createdAt >= input.from)
        .filter((item) => !excluded.has(item.id))
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
      return {
        messages: filtered.slice(0, input.limit).toReversed(),
        hasMore: filtered.length > input.limit,
        oldestAvailable: messages.at(-1)?.createdAt ?? null,
      };
    },
  };
}

function makeTool(
  messages: TestMessage[],
  options: {
    scope?: 'chat' | 'direct';
    contextMessageCount?: number;
    defaultBefore?: Date;
    seen?: Set<string>;
    access?: Access;
  } = {},
) {
  const store = createStore(messages);
  const seen = options.seen ?? new Set<string>();
  const tool = createLocalChatHistoryTool({
    scope: options.scope ?? 'chat',
    contextMessageCount: options.contextMessageCount ?? 0,
    ...(options.defaultBefore ? { defaultBefore: options.defaultBefore } : {}),
    seenMessageIds: seen,
    checkAccess: async () => options.access ?? { allowed: true },
    getMessages: (input) => store.getMessages(input),
  });
  return { tool, requests: store.requests, seen };
}

test('get_local_chat_history returns messages older than the anchor and a cursor', async () => {
  const messages = Array.from({ length: 12 }, (_, index) => message(index));
  const seen = new Set(['m5']);
  const { tool } = makeTool(messages, {
    defaultBefore: messages[5]?.createdAt,
    contextMessageCount: 1,
    seen,
  });

  const first = JSON.parse(await tool.execute({ limit: 3 }));
  assert.equal(first.status, 'partial');
  assert.equal(first.scope, 'chat');
  assert.equal(first.complete, false);
  assert.equal(first.has_more, true);
  assert.deepEqual(
    first.messages.map((item: { text: string }) => item.text),
    ['сообщение 8', 'сообщение 7', 'сообщение 6'],
  );
  assert.equal(first.next_before, messages[8]?.createdAt.toISOString());
  assert.equal(first.oldest_available, messages[11]?.createdAt.toISOString());

  const second = JSON.parse(await tool.execute({ before: first.next_before, limit: 3 }));
  assert.deepEqual(
    second.messages.map((item: { text: string }) => item.text),
    ['сообщение 11', 'сообщение 10', 'сообщение 9'],
  );
});

test('get_local_chat_history does not repeat messages across calls', async () => {
  const messages = Array.from({ length: 12 }, (_, index) => message(index));
  const { tool, seen } = makeTool(messages, {
    defaultBefore: messages[5]?.createdAt,
    seen: new Set(['m5']),
  });

  const first = JSON.parse(await tool.execute({ limit: 3 }));
  const second = JSON.parse(await tool.execute({ limit: 3 }));
  const firstIds: string[] = first.messages.map((item: { text: string }) => item.text);
  const secondIds: string[] = second.messages.map((item: { text: string }) => item.text);

  assert.equal(new Set([...firstIds, ...secondIds]).size, firstIds.length + secondIds.length);
  assert.equal(seen.size, 7);
});

test('get_local_chat_history enforces the call limit', async () => {
  const messages = Array.from({ length: 100 }, (_, index) => message(index));
  const { tool, requests } = makeTool(messages, {
    defaultBefore: new Date('2026-11-15T00:00:00.000Z'),
  });

  for (let index = 0; index < 3; index += 1) {
    const result = JSON.parse(await tool.execute({ limit: 10 }));
    assert.equal(result.returned, 10);
  }
  const blocked = JSON.parse(await tool.execute({ limit: 10 }));
  assert.equal(blocked.status, 'not_executed');
  assert.match(blocked.message, /Лимит вызовов/u);
  assert.equal(requests.length, 3);
});

test('get_local_chat_history enforces the total message budget', async () => {
  const messages = Array.from({ length: 200 }, (_, index) => message(index));
  const { tool, requests } = makeTool(messages, {
    defaultBefore: new Date('2026-11-15T00:00:00.000Z'),
  });

  const first = JSON.parse(await tool.execute({ limit: 50 }));
  const second = JSON.parse(await tool.execute({ limit: 50 }));
  assert.equal(first.returned, 50);
  assert.equal(second.returned, 50);
  assert.equal(second.suggest_digest, true);

  const blocked = JSON.parse(await tool.execute({ limit: 10 }));
  assert.equal(blocked.status, 'not_executed');
  assert.match(blocked.message, /Лимит контекста/u);
  assert.equal(requests.length, 2);
});

test('get_local_chat_history stops when the character budget is exhausted', async () => {
  const messages = Array.from({ length: 30 }, (_, index) =>
    message(index, { content: 'я'.repeat(1_000) }),
  );
  const { tool } = makeTool(messages, {
    defaultBefore: new Date('2026-11-15T00:00:00.000Z'),
  });

  const result = JSON.parse(await tool.execute({ limit: 50 }));
  assert.equal(result.status, 'partial');
  assert.equal(result.has_more, true);
  assert.equal(result.suggest_digest, true);
  assert.ok(result.returned < 30);
  assert.match(result.limitation, /Лимит контекста/u);
});

test('get_local_chat_history truncates long messages', async () => {
  const { tool } = makeTool([message(1, { content: 'я'.repeat(5_000) })], {
    defaultBefore: new Date('2026-11-15T00:00:00.000Z'),
  });

  const result = JSON.parse(await tool.execute({ limit: 10 }));
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].text.length, 1_000);
  assert.equal(result.messages[0].truncated, true);
  assert.match(result.limitation, /обрезана/u);
});

test('get_local_chat_history returns an empty result', async () => {
  const { tool } = makeTool([], {
    defaultBefore: new Date('2026-11-15T00:00:00.000Z'),
  });

  const result = JSON.parse(await tool.execute({ limit: 10 }));
  assert.equal(result.status, 'empty');
  assert.equal(result.returned, 0);
  assert.equal(result.complete, true);
  assert.equal(result.has_more, false);
});

test('get_local_chat_history validates input and access', async () => {
  const messages = Array.from({ length: 5 }, (_, index) => message(index));
  const { tool, requests } = makeTool(messages, {
    defaultBefore: new Date('2026-11-15T00:00:00.000Z'),
  });

  const invalidBefore = JSON.parse(await tool.execute({ before: 'вчера' }));
  assert.equal(invalidBefore.status, 'not_executed');

  const invalidRange = JSON.parse(
    await tool.execute({
      from: '2026-11-14T12:00:00.000Z',
      before: '2026-11-14T11:00:00.000Z',
    }),
  );
  assert.equal(invalidRange.status, 'not_executed');

  const invalidLimit = JSON.parse(await tool.execute({ limit: 51 }));
  assert.equal(invalidLimit.status, 'not_executed');

  const unknownKey = JSON.parse(await tool.execute({ after: '2026-11-14T11:00:00.000Z' }));
  assert.equal(unknownKey.status, 'not_executed');

  const future = JSON.parse(await tool.execute({ before: '2999-01-01T00:00:00.000Z' }));
  assert.equal(future.status, 'not_executed');

  const denied = JSON.parse(
    await (async () => {
      const blocked = makeTool(messages, {
        defaultBefore: new Date('2026-11-15T00:00:00.000Z'),
        access: { allowed: false, message: 'Нет доступа' },
      });
      return blocked.tool.execute({ limit: 5 });
    })(),
  );
  assert.equal(denied.status, 'not_executed');
  assert.equal(denied.message, 'Нет доступа');
  assert.equal(requests.length, 0);
});

test('get_local_chat_history reports direct scope', async () => {
  const { tool } = makeTool([message(1)], {
    scope: 'direct',
    defaultBefore: new Date('2026-11-15T00:00:00.000Z'),
  });

  const result = JSON.parse(await tool.execute({ limit: 10 }));
  assert.equal(result.scope, 'direct');
  assert.equal(result.context_messages, 0);
});
