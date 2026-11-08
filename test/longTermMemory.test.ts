import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { prisma } from '../src/db/client.js';
import type { AIMessage, AIProvider, AIResponse } from '../src/services/ai/AIProvider.js';
import {
  LongTermMemoryService,
  type MemoryControlContext,
} from '../src/services/memory/longTermMemoryService.js';
import type { MemoryEmbeddingProvider } from '../src/services/memory/memoryEmbeddings.js';
import {
  containsSensitiveMemoryData,
  hasCollectiveMemoryCue,
  keywordRelevance,
  memoryFingerprint,
  shouldConsiderAutomaticMemory,
} from '../src/services/memory/memorySafety.js';

function extractionProvider(): AIProvider {
  return {
    name: 'memory-test',
    async send(messages: AIMessage[]): Promise<AIResponse> {
      const input = JSON.parse(messages.at(-1)?.content ?? '{}') as { message?: string };
      const message = input.message ?? '';
      const group = /мы\s+договорились/iu.test(message);
      return {
        provider: this.name,
        content: JSON.stringify({
          items: [
            {
              scope: group ? 'conversation' : 'personal',
              action: 'create',
              category: group ? 'agreement' : 'preference',
              content: group
                ? 'Беседа договорилась встречаться по средам.'
                : 'Пользователь любит научную фантастику.',
              importance: 0.9,
              confidence: 0.96,
              validDays: null,
              relatedMemoryIds: [],
            },
          ],
        }),
      };
    },
  };
}

const embeddings: MemoryEmbeddingProvider = {
  model: 'test-embedding-model',
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) =>
      /фантаст|фильм|кино/iu.test(text) ? [1, 0] : /сред|встреч/iu.test(text) ? [0, 1] : [0.2, 0.2],
    );
  },
};

test('memory safety filters sensitive text and narrows automatic analysis', () => {
  assert.equal(containsSensitiveMemoryData('Запомни мой пароль: example123'), true);
  assert.equal(containsSensitiveMemoryData('Я люблю научную фантастику'), false);
  assert.equal(shouldConsiderAutomaticMemory('Я люблю научную фантастику'), true);
  assert.equal(shouldConsiderAutomaticMemory('Сегодня поел суп'), false);
  assert.equal(hasCollectiveMemoryCue('Мы договорились встречаться по средам'), true);
  assert.equal(keywordRelevance('научную фантастику', 'Любит научную фантастику'), 1);
});

test('personal memories are stored, semantically retrieved, and isolated from group context', async (t) => {
  const vkUserId = `memory-${randomUUID()}`;
  const conversationId = `2000000${randomUUID().replaceAll('-', '').slice(0, 5)}`;
  const user = await prisma.user.create({ data: { vkId: vkUserId } });
  await prisma.userSettings.create({ data: { userId: user.id } });
  const conversation = await prisma.conversation.create({
    data: { id: conversationId, isGroup: true },
  });
  await prisma.chatSettings.create({ data: { conversationId: conversation.id } });
  t.after(async () => {
    await prisma.conversation.deleteMany({ where: { id: conversationId } });
    await prisma.user.deleteMany({ where: { vkId: vkUserId } });
  });

  const service = new LongTermMemoryService(prisma, embeddings);
  const context: MemoryControlContext = {
    vkUserId,
    conversationId,
    isChat: false,
  };
  await service.captureAutomatically('Я люблю научную фантастику.', context, extractionProvider());

  const userMemories = await prisma.longTermMemory.findMany({ where: { userId: user.id } });
  assert.equal(userMemories.length, 1);
  assert.equal(userMemories[0]?.scope, 'personal');

  const saved = await service.handleControlMessage(
    'Пенёк, запомни, что я люблю научную фантастику.',
    context,
    extractionProvider(),
  );
  assert.match(saved?.publicMessage ?? '', /Сохранил/u);
  assert.equal(await prisma.longTermMemory.count({ where: { userId: user.id } }), 1);

  const directResult = await service.getRelevantMemories({
    vkUserId,
    conversationId,
    isChat: false,
    query: 'Посоветуй фильм про космос',
  });
  assert.equal(directResult[0]?.content, 'Пользователь любит научную фантастику.');

  const groupResult = await service.getRelevantMemories({
    vkUserId,
    conversationId,
    isChat: true,
    query: 'Посоветуй фильм про космос',
  });
  assert.equal(groupResult.length, 0);
});

test('group memories require a shared context and personal memory is delivered privately', async (t) => {
  const vkUserId = `memory-${randomUUID()}`;
  const conversationId = `2000000${randomUUID().replaceAll('-', '').slice(0, 5)}`;
  const user = await prisma.user.create({ data: { vkId: vkUserId } });
  await prisma.userSettings.create({ data: { userId: user.id } });
  const conversation = await prisma.conversation.create({
    data: { id: conversationId, isGroup: true },
  });
  await prisma.chatSettings.create({ data: { conversationId: conversation.id } });
  t.after(async () => {
    await prisma.conversation.deleteMany({ where: { id: conversationId } });
    await prisma.user.deleteMany({ where: { vkId: vkUserId } });
  });

  const service = new LongTermMemoryService(prisma, embeddings);
  const provider = extractionProvider();
  const context: MemoryControlContext = {
    vkUserId,
    conversationId,
    isChat: true,
  };
  await service.captureAutomatically('Мы договорились встречаться по средам.', context, provider);
  const groupMemories = await prisma.longTermMemory.findMany({
    where: { conversationId },
  });
  assert.equal(groupMemories.length, 1);
  assert.equal(groupMemories[0]?.userId, null);
  assert.equal(groupMemories[0]?.scope, 'conversation');
  const explicitlySaved = await service.handleControlMessage(
    'Пенёк, запомни в общую память беседы, что мы договорились встречаться по средам.',
    context,
    provider,
  );
  assert.match(explicitlySaved?.publicMessage ?? '', /общей памяти/u);
  assert.equal(await prisma.longTermMemory.count({ where: { conversationId } }), 1);

  await service.captureAutomatically('Я люблю научную фантастику.', context, provider);
  const personalMemories = await prisma.longTermMemory.findMany({
    where: { userId: user.id },
  });
  assert.equal(personalMemories.length, 1);

  const response = await service.handleControlMessage('Покажи мою память', context, provider);
  assert.match(response?.privateMessage ?? '', /научную фантастику/u);
  assert.doesNotMatch(response?.publicMessage ?? '', /научную фантастику/u);
});

test('automatic memory collection can be disabled independently of stored memories', async (t) => {
  const vkUserId = `memory-${randomUUID()}`;
  const conversationId = `dm-${randomUUID()}`;
  const user = await prisma.user.create({ data: { vkId: vkUserId } });
  await prisma.userSettings.create({
    data: { userId: user.id, autoMemoryEnabled: false },
  });
  t.after(async () => {
    await prisma.user.deleteMany({ where: { vkId: vkUserId } });
  });

  const service = new LongTermMemoryService(prisma, embeddings);
  await service.handleControlMessage(
    'Пенёк, отключи автоматическое запоминание.',
    { vkUserId, conversationId, isChat: false },
    extractionProvider(),
  );
  await service.captureAutomatically(
    'Я люблю научную фантастику.',
    { vkUserId, conversationId, isChat: false },
    extractionProvider(),
  );
  assert.equal(await prisma.longTermMemory.count({ where: { userId: user.id } }), 0);
});

test('ambiguous personal deletion asks privately and accepts a follow-up selection', async (t) => {
  const vkUserId = `memory-${randomUUID()}`;
  const conversationId = `2000000${randomUUID().replaceAll('-', '').slice(0, 5)}`;
  const user = await prisma.user.create({ data: { vkId: vkUserId } });
  const conversation = await prisma.conversation.create({
    data: { id: conversationId, isGroup: true },
  });
  await prisma.chatSettings.create({ data: { conversationId: conversation.id } });
  await prisma.longTermMemory.create({
    data: {
      scope: 'personal',
      userId: user.id,
      createdByVkId: vkUserId,
      category: 'preference',
      content: 'Любит фантастические фильмы.',
      fingerprint: memoryFingerprint('Любит фантастические фильмы.'),
      importance: 0.8,
      confidence: 0.9,
      embedding: JSON.stringify([1, 0]),
      embeddingModel: embeddings.model,
    },
  });
  await prisma.longTermMemory.create({
    data: {
      scope: 'personal',
      userId: user.id,
      createdByVkId: vkUserId,
      category: 'preference',
      content: 'Любит комедийные фильмы.',
      fingerprint: memoryFingerprint('Любит комедийные фильмы.'),
      importance: 0.8,
      confidence: 0.9,
      embedding: JSON.stringify([1, 0]),
      embeddingModel: embeddings.model,
    },
  });
  t.after(async () => {
    await prisma.conversation.deleteMany({ where: { id: conversationId } });
    await prisma.user.deleteMany({ where: { vkId: vkUserId } });
  });

  const service = new LongTermMemoryService(prisma, embeddings);
  const context: MemoryControlContext = {
    vkUserId,
    conversationId,
    isChat: true,
  };
  const clarification = await service.handleControlMessage(
    'Забудь про фильмы',
    context,
    extractionProvider(),
  );
  assert.match(clarification?.privateMessage ?? '', /фильмы/u);
  assert.doesNotMatch(clarification?.publicMessage ?? '', /фильмы/u);
  assert.equal(await service.hasPendingSelection(vkUserId, conversationId, '2'), true);

  await service.handleControlMessage('2', context, extractionProvider());
  assert.equal(await prisma.longTermMemory.count({ where: { userId: user.id } }), 1);
  assert.equal(await prisma.memoryActionDraft.count({ where: { userId: user.id } }), 0);
});
