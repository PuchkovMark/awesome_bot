import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import config from '../src/config/index.js';
import { prisma } from '../src/db/client.js';
import type { AIMessage, AIProvider, AIRequestOptions } from '../src/services/ai/AIProvider.js';
import {
  buildChatDigest,
  countHistoryMessages,
  estimateHistoryMessages,
  finalizeChatDigest,
  summarizeHistorySnapshot,
  UsageBudget,
  UsageLimitError,
  type ChatDigestChunk,
  type HistoryMessage,
} from '../src/services/ai/chatDigestService.js';
import { AIOutputLimitError } from '../src/services/ai/chatCompletion.js';

type MockCall = {
  messages: AIMessage[];
  options?: AIRequestOptions;
};

const conversationId = '2000000001';

function dbRow(index: number) {
  const timestamp = new Date(`2026-11-12T10:00:${String(index).padStart(2, '0')}.000Z`);
  return {
    id: `m${index}`,
    conversationId,
    userId: 'user-1',
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `сообщение ${index}`,
    provider: null,
    tokens: null,
    metadata: null,
    vkMessageId: index,
    conversationMessageId: index,
    sentAt: timestamp,
    fromId: 1,
    authorName: 'Иван Петров',
    replyToVkMessageId: null,
    replyToConversationMessageId: null,
    replyToFromId: null,
    replyToAuthorName: null,
    replyToText: null,
    attachments: null,
    createdAt: timestamp,
    user: { vkId: '1', displayName: 'Иван Петров' },
  };
}

function mockFindMany(t: TestContext, rows: unknown[]) {
  const original: typeof prisma.message.findMany = Reflect.get(prisma.message, 'findMany');
  prisma.message.findMany = (async () => rows) as typeof prisma.message.findMany;
  t.after(() => {
    prisma.message.findMany = original;
  });
}

function mockCount(t: TestContext, value: number) {
  const original: typeof prisma.message.count = Reflect.get(prisma.message, 'count');
  prisma.message.count = (async () => value) as typeof prisma.message.count;
  t.after(() => {
    prisma.message.count = original;
  });
}

function chunkDigest(index: number): ChatDigestChunk {
  return {
    from: `2026-11-12T10:0${index}:00.000Z`,
    to: `2026-11-12T10:0${index + 1}:00.000Z`,
    message_count: 300,
    topics: [`тема ${index}`],
    decisions: [],
    questions: [],
    agreements: [],
    facts: [`факт ${index}`],
    participants: ['Иван Петров'],
  };
}

function longChunkDigest(index: number): ChatDigestChunk {
  const text = (label: string, length: number) =>
    `${label} ${index} ${'x'.repeat(length)}`.slice(0, length);
  return {
    ...chunkDigest(index),
    topics: Array.from({ length: 4 }, (_, item) => text(`тема ${item}`, 60)),
    decisions: Array.from({ length: 4 }, (_, item) => text(`решение ${item}`, 60)),
    questions: Array.from({ length: 4 }, (_, item) => text(`вопрос ${item}`, 60)),
    agreements: Array.from({ length: 4 }, (_, item) => text(`договорённость ${item}`, 60)),
    facts: Array.from({ length: 6 }, (_, item) => text(`факт ${item}`, 100)),
  };
}

function mockProvider(calls: MockCall[]): AIProvider {
  return {
    name: 'mock',
    async send(messages, options) {
      calls.push({ messages, options });
      const system = Array.isArray(messages) ? messages[0]?.content : '';
      if (typeof system === 'string' && system.includes('финальный краткий пересказ')) {
        return { content: 'Финальный пересказ. '.repeat(500) };
      }
      if (typeof system === 'string' && system.includes('Объедини структурированные')) {
        return { content: JSON.stringify(chunkDigest(1)) };
      }
      return { content: JSON.stringify(chunkDigest(0)) };
    },
  };
}

test('buildChatDigest loads only SQL messages and asks Haiku for chunks', async (t) => {
  const rows = Array.from({ length: 6 }, (_, index) => dbRow(index));
  mockFindMany(t, rows);
  const providerCalls: MockCall[] = [];
  const result = await buildChatDigest(mockProvider(providerCalls), {
    conversationId,
    request: { count: 600 },
    maxDigestChars: config.SUMMARY_MAX_DIGEST_CHARS,
  });
  assert.equal(result.messageCount, 6);
  assert.equal(result.source, 'db');
  assert.equal(result.digests.length, 1);
  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0]?.options?.model, config.SUMMARY_MODEL);
  assert.equal(providerCalls[0]?.options?.maxOutputTokens, config.SUMMARY_CHUNK_OUTPUT_TOKENS);
});

test('buildChatDigest returns no digests for empty history', async (t) => {
  mockFindMany(t, []);
  const calls: MockCall[] = [];
  const result = await buildChatDigest(mockProvider(calls), {
    conversationId,
    request: { count: 10 },
    maxDigestChars: 10_000,
  });
  assert.equal(result.messageCount, 0);
  assert.deepEqual(result.digests, []);
  assert.equal(calls.length, 0);
});

test('countHistoryMessages counts SQL messages and caps by requested count', async (t) => {
  mockCount(t, 500);
  assert.equal(await countHistoryMessages({ conversationId, request: { count: 600 } }), 500);
  assert.equal(await countHistoryMessages({ conversationId, request: { count: 100 } }), 100);
  assert.equal(
    await countHistoryMessages({
      conversationId,
      request: { from: new Date('2026-11-12T00:00:00Z'), to: new Date('2026-11-13T00:00:00Z') },
    }),
    500,
  );
});

test('estimateHistoryMessages rejects an over-limit period without loading text', async (t) => {
  mockCount(t, 3_500);
  const estimate = await estimateHistoryMessages({
    conversationId,
    request: {
      from: new Date('2026-11-13T11:00:00Z'),
      to: new Date('2026-11-13T19:00:00Z'),
    },
  });
  assert.deepEqual(estimate, { count: 3_500, chars: 0, capped: true });
});

test('estimateHistoryMessages returns character volume for a fitting range', async (t) => {
  mockCount(t, 2);
  mockFindMany(t, [dbRow(1), dbRow(2)]);
  const estimate = await estimateHistoryMessages({
    conversationId,
    request: { count: 10 },
  });
  assert.equal(estimate.count, 2);
  assert.ok(estimate.chars > 0);
  assert.equal(estimate.capped, false);
});

test('UsageBudget stops a summary when the token budget is exceeded', async () => {
  const budget = new UsageBudget(50, 50);
  const provider: AIProvider = {
    name: 'mock',
    async send() {
      return {
        content: JSON.stringify(chunkDigest(0)),
        inputTokens: 100,
        outputTokens: 10,
      };
    },
  };
  const message: HistoryMessage = {
    dbId: 'm1',
    timestamp: 1_763_000_000_000,
    author: 'Иван',
    role: 'user',
    text: 'привет',
    attachments: [],
  };
  await assert.rejects(
    () => summarizeHistorySnapshot(provider, [message], { usage: budget }),
    (error: unknown) => error instanceof UsageLimitError,
  );
});

test('finalizeChatDigest uses the main provider and clamps the answer', async () => {
  const calls: MockCall[] = [];
  const result = await finalizeChatDigest(
    mockProvider(calls),
    { count: 6_000 },
    [chunkDigest(0)],
    3_500,
    'Europe/Moscow',
  );
  assert.ok(result.length <= 3_500);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.options?.model, undefined);
  assert.equal(calls[0]?.options?.maxOutputTokens, 4_200);
});

test('finalizeChatDigest reports the actual processed message count', async () => {
  const calls: MockCall[] = [];
  await finalizeChatDigest(
    mockProvider(calls),
    { count: 1_000 },
    [chunkDigest(0)],
    3_500,
    'Europe/Moscow',
    { messageCount: 200, source: 'db' },
  );
  const messages = calls[0]?.messages;
  assert.ok(Array.isArray(messages));
  const system = messages[0]?.content;
  assert.equal(typeof system, 'string');
  assert.match(system, /Фактически обработано 200 сообщений/u);
  assert.match(system, /локальная история/u);
});

test('buildChatDigest retries a chunk with a larger output limit', async (t) => {
  mockFindMany(t, [dbRow(1)]);
  const calls: MockCall[] = [];
  let attempts = 0;
  const provider: AIProvider = {
    name: 'mock',
    async send(messages, options) {
      calls.push({ messages, options });
      attempts += 1;
      if (attempts === 1) {
        throw new AIOutputLimitError(options?.maxOutputTokens ?? 0);
      }
      return { content: JSON.stringify(chunkDigest(0)) };
    },
  };

  const result = await buildChatDigest(provider, {
    conversationId,
    request: { count: 100 },
    maxDigestChars: 10_000,
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.options?.maxOutputTokens, config.SUMMARY_CHUNK_OUTPUT_TOKENS);
  assert.equal(calls[1]?.options?.maxOutputTokens, config.SUMMARY_CHUNK_OUTPUT_TOKENS_MAX);
  assert.equal(result.digests[0]?.topics[0], 'тема 0');
});

test('buildChatDigest splits a chunk after both output limits are exhausted', async (t) => {
  mockFindMany(t, [dbRow(1), dbRow(2), dbRow(3), dbRow(4)]);
  const calls: MockCall[] = [];
  let attempts = 0;
  const provider: AIProvider = {
    name: 'mock',
    async send(messages, options) {
      calls.push({ messages, options });
      attempts += 1;
      if (attempts <= 2) {
        throw new AIOutputLimitError(options?.maxOutputTokens ?? 0);
      }
      return {
        content: JSON.stringify({
          ...chunkDigest(0),
          topics: [`тема после split ${attempts}`],
        }),
      };
    },
  };

  const result = await buildChatDigest(provider, {
    conversationId,
    request: { count: 100 },
    maxDigestChars: 10_000,
  });

  assert.ok(calls.length >= 4);
  assert.ok(result.digests.length > 0);
  assert.ok(result.digests[0]?.topics.length);
});

test('buildChatDigest falls back to deterministic combine when merge hits the output limit', async (t) => {
  const originalChunkMessages = config.SUMMARY_CHUNK_MESSAGES;
  config.SUMMARY_CHUNK_MESSAGES = 1;
  t.after(() => {
    config.SUMMARY_CHUNK_MESSAGES = originalChunkMessages;
  });
  mockFindMany(
    t,
    Array.from({ length: 3 }, (_, index) => dbRow(index)),
  );
  const calls: MockCall[] = [];
  let chunkIndex = 0;
  const provider: AIProvider = {
    name: 'mock',
    async send(messages, options) {
      calls.push({ messages, options });
      const system = messages[0]?.content;
      if (typeof system === 'string' && system.includes('Объедини структурированные')) {
        throw new AIOutputLimitError(options?.maxOutputTokens ?? 0);
      }
      return { content: JSON.stringify(longChunkDigest(chunkIndex++)) };
    },
  };

  const result = await buildChatDigest(provider, {
    conversationId,
    request: { count: 900 },
    maxDigestChars: 1_000,
  });

  assert.ok(result.digests.length > 0);
  assert.ok(
    calls.some(({ messages }) => {
      const system = messages[0]?.content;
      return typeof system === 'string' && system.includes('Объедини структурированные');
    }),
  );
});

test('HistoryMessage has the fields needed by the subagent snapshot', () => {
  const message: HistoryMessage = {
    dbId: 'm1',
    timestamp: 1_763_000_000_000,
    author: 'Иван',
    role: 'user',
    text: 'привет',
    attachments: [],
  };
  assert.equal(message.role, 'user');
  assert.equal(message.dbId, 'm1');
});
