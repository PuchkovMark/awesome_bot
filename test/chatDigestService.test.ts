import assert from 'node:assert/strict';
import { test } from 'node:test';
import config from '../src/config/index.js';
import { prisma } from '../src/db/client.js';
import type { AIMessage, AIProvider, AIRequestOptions } from '../src/services/ai/AIProvider.js';
import {
  buildChatDigest,
  finalizeChatDigest,
  type ChatDigestChunk,
} from '../src/services/ai/chatDigestService.js';
import { AIOutputLimitError } from '../src/services/ai/chatCompletion.js';
import type { VK } from 'vk-io';

type MockCall = {
  messages: AIMessage[];
  options?: AIRequestOptions;
};

const peers = 2_000_000_001;

function vkMessage(id: number) {
  return {
    id,
    peer_id: peers,
    conversation_message_id: id,
    date: 1_763_000_000 + id,
    from_id: 1,
    text: `сообщение ${id}`,
    attachments: [],
    is_hidden: false,
  };
}

function mockApi(calls: number[][]): VK['api'] {
  return {
    messages: {
      getByConversationMessageId: async (request: { conversation_message_ids: number[] }) => {
        calls.push(request.conversation_message_ids);
        return {
          count: request.conversation_message_ids.length,
          items: request.conversation_message_ids.map(vkMessage),
          profiles: [{ id: 1, first_name: 'Иван', last_name: 'Петров' }],
          groups: [],
        };
      },
    },
  } as unknown as VK['api'];
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

test('buildChatDigest fetches messages and asks Haiku for structured chunks', async () => {
  const fetchCalls: number[][] = [];
  const providerCalls: MockCall[] = [];
  const result = await buildChatDigest(mockProvider(providerCalls), {
    api: mockApi(fetchCalls),
    peerId: peers,
    anchorConversationMessageId: 1_000,
    request: { count: 600 },
    maxDigestChars: config.SUMMARY_MAX_DIGEST_CHARS,
  });
  assert.equal(result.messageCount, 600);
  assert.equal(result.digests.length, 3);
  assert.equal(providerCalls.length, 3);
  assert.equal(providerCalls[0]?.options?.model, config.SUMMARY_MODEL);
  assert.equal(providerCalls[0]?.options?.maxOutputTokens, config.SUMMARY_CHUNK_OUTPUT_TOKENS);
  assert.ok(fetchCalls.length >= 6);
  assert.equal(result.digests[0]?.topics[0], 'тема 0');
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

test('buildChatDigest uses only the database when VK is disabled', async (t) => {
  const originalFindMany: typeof prisma.message.findMany = Reflect.get(prisma.message, 'findMany');
  prisma.message.findMany = (async () => []) as typeof prisma.message.findMany;
  t.after(() => {
    prisma.message.findMany = originalFindMany;
  });
  const fetchCalls: number[][] = [];
  const providerCalls: MockCall[] = [];
  const result = await buildChatDigest(mockProvider(providerCalls), {
    api: mockApi(fetchCalls),
    peerId: 42,
    request: { count: 100 },
    allowVk: false,
    maxDigestChars: 10_000,
  });
  assert.equal(result.messageCount, 0);
  assert.equal(result.source, 'db');
  assert.equal(fetchCalls.length, 0);
  assert.equal(providerCalls.length, 0);
});

test('buildChatDigest returns no digests for empty history', async () => {
  const calls: MockCall[] = [];
  const result = await buildChatDigest(mockProvider(calls), {
    api: {
      messages: {
        getByConversationMessageId: async () => ({
          count: 0,
          items: [],
          profiles: [],
          groups: [],
        }),
      },
    } as unknown as VK['api'],
    peerId: peers,
    anchorConversationMessageId: 1,
    request: { count: 10 },
    maxDigestChars: 10_000,
  });
  assert.equal(result.messageCount, 0);
  assert.deepEqual(result.digests, []);
  assert.equal(calls.length, 0);
});

test('buildChatDigest retries a chunk with a larger output limit', async () => {
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
    api: mockApi([]),
    peerId: peers,
    anchorConversationMessageId: 1_000,
    request: { count: 100 },
    maxDigestChars: 10_000,
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.options?.maxOutputTokens, config.SUMMARY_CHUNK_OUTPUT_TOKENS);
  assert.equal(calls[1]?.options?.maxOutputTokens, config.SUMMARY_CHUNK_OUTPUT_TOKENS_MAX);
  assert.equal(result.digests[0]?.topics[0], 'тема 0');
});

test('buildChatDigest splits a chunk after both output limits are exhausted', async () => {
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
    api: mockApi([]),
    peerId: peers,
    anchorConversationMessageId: 1_000,
    request: { count: 100 },
    maxDigestChars: 10_000,
  });

  assert.equal(calls.length, 4);
  assert.deepEqual(result.digests[0]?.topics, ['тема после split 3', 'тема после split 4']);
});

test('buildChatDigest falls back to deterministic combine when merge hits the output limit', async () => {
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
    api: mockApi([]),
    peerId: peers,
    anchorConversationMessageId: 1_000,
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
