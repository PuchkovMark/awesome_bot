import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { prisma } from '../src/db/client.js';
import memoryService from '../src/services/memory/memoryService.js';

test('cleanup removes expired messages when the conversation has no settings row', async () => {
  const conversationId = `cleanup-nosettings-${randomUUID()}`;
  const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000);
  try {
    await prisma.conversation.create({ data: { id: conversationId, isGroup: true } });
    await prisma.message.create({
      data: { conversationId, role: 'user', content: 'старое сообщение', createdAt: oldDate },
    });

    const deleted = await memoryService.cleanupOldContext();
    assert.ok(deleted >= 1);
    assert.equal(await prisma.message.count({ where: { conversationId } }), 0);
  } finally {
    await prisma.message.deleteMany({ where: { conversationId } });
    await prisma.conversation.deleteMany({ where: { id: conversationId } });
  }
});

test('cleanup keeps messages of weekly-meme chats until the 7-day cutoff', async () => {
  const conversationId = `cleanup-weekly-${randomUUID()}`;
  const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  try {
    await prisma.conversation.create({ data: { id: conversationId, isGroup: true } });
    await prisma.chatSettings.create({
      data: { conversationId, memeDayWeeklyEnabled: true },
    });
    await prisma.message.create({
      data: { conversationId, role: 'user', content: 'свежее для мема', createdAt: twoDaysAgo },
    });
    await prisma.message.create({
      data: { conversationId, role: 'user', content: 'слишком старое', createdAt: eightDaysAgo },
    });

    await memoryService.cleanupOldContext();
    const remaining = await prisma.message.findMany({
      where: { conversationId },
      select: { content: true },
    });
    assert.deepEqual(remaining, [{ content: 'свежее для мема' }]);
  } finally {
    await prisma.message.deleteMany({ where: { conversationId } });
    await prisma.conversation.deleteMany({ where: { id: conversationId } });
  }
});
