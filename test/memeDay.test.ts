import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { prisma } from '../src/db/client.js';
import settingsService from '../src/services/settings/settingsService.js';
import memeDayService from '../src/services/fun/memeDayService.js';
import { getMemeDaySchedule } from '../src/jobs/memeDayJob.js';
import memoryService from '../src/services/memory/memoryService.js';

test('daily meme schedule respects the conversation timezone and weekly publication replaces daily', () => {
  const settings = {
    enabled: true,
    weeklyEnabled: true,
    dailyTime: '20:00',
    timezone: 'Europe/Moscow',
  };
  assert.deepEqual(
    getMemeDaySchedule(new Date('2026-11-08T17:00:00.000Z'), '2000000001', settings),
    [{ key: '2000000001:weekly:2026-W45', kind: 'weekly' }],
  );
  assert.deepEqual(
    getMemeDaySchedule(new Date('2026-11-06T17:00:00.000Z'), '2000000001', settings),
    [{ key: '2000000001:daily:2026-11-06', kind: 'daily' }],
  );
  assert.deepEqual(
    getMemeDaySchedule(new Date('2026-11-06T16:59:00.000Z'), '2000000001', settings),
    [],
  );
});

test('meme day settings and schedule claims are isolated per conversation', async () => {
  const first = `meme-day-${randomUUID()}`;
  const second = `meme-day-${randomUUID()}`;
  const scheduleKey = `${first}:daily:2026-11-06`;
  try {
    await settingsService.getChatSettings(first);
    await settingsService.getChatSettings(second);
    const updated = await memeDayService.updateSettings(first, {
      enabled: true,
      dailyTime: '19:30',
      timezone: 'Europe/Moscow',
    });
    const independent = await memeDayService.getSettings(second);

    assert.equal(updated.enabled, true);
    assert.equal(updated.dailyTime, '19:30');
    assert.equal(updated.timezone, 'Europe/Moscow');
    assert.equal(independent.enabled, false);
    assert.equal(independent.dailyTime, '20:00');

    const claim = await memeDayService.claimScheduled(first, scheduleKey, 'daily');
    assert.ok(claim);
    assert.equal(await memeDayService.claimScheduled(first, scheduleKey, 'daily'), null);
    await memeDayService.markSkipped(claim);
    assert.equal(await memeDayService.claimScheduled(first, scheduleKey, 'daily'), null);
  } finally {
    await prisma.conversation.deleteMany({ where: { id: { in: [first, second] } } });
  }
});

test('meme day votes replace a participant previous vote and rank the publication', async () => {
  const conversationId = `meme-day-${randomUUID()}`;
  try {
    await settingsService.getChatSettings(conversationId);
    const publicationId = await memeDayService.beginManual(conversationId, 'group');
    await memeDayService.complete(publicationId, {
      kind: 'group',
      topic: 'общая тема',
      caption: 'тестовый мем',
      funOutputId: 'output-test',
      attachment: 'photo1_2',
    });

    assert.deepEqual(await memeDayService.vote(conversationId, publicationId, 'user-1', 'fire'), {
      score: 2,
      count: 1,
    });
    assert.deepEqual(
      await memeDayService.vote(conversationId, publicationId, 'user-1', 'dislike'),
      { score: -1, count: 1 },
    );
    assert.equal((await memeDayService.top(conversationId))[0]?.votes.length, 1);
    assert.equal((await memeDayService.top(conversationId))[0]?.score, -1);
    assert.equal(
      await memeDayService.vote('another-conversation', publicationId, 'user-2', 'laugh'),
      null,
    );
  } finally {
    await prisma.conversation.deleteMany({ where: { id: conversationId } });
  }
});

test('weekly meme context is retained for up to seven days only when enabled', async () => {
  const weeklyConversation = `meme-day-${randomUUID()}`;
  const regularConversation = `meme-day-${randomUUID()}`;
  const oldMessageDate = new Date(Date.now() - 48 * 60 * 60_000);
  try {
    await settingsService.getChatSettings(weeklyConversation);
    await settingsService.getChatSettings(regularConversation);
    await memeDayService.updateSettings(weeklyConversation, { weeklyEnabled: true });
    const weeklySettings = await prisma.chatSettings.findUniqueOrThrow({
      where: { conversationId: weeklyConversation },
      select: { memeDayWeeklyEnabled: true },
    });
    assert.equal(weeklySettings.memeDayWeeklyEnabled, true);

    await Promise.all(
      [weeklyConversation, regularConversation].map((conversationId) =>
        prisma.message.create({
          data: {
            conversationId,
            role: 'user',
            content: 'старое сообщение',
            createdAt: oldMessageDate,
          },
        }),
      ),
    );
    await memoryService.cleanupOldContext();

    assert.ok(
      await prisma.message.findFirst({
        where: { conversationId: weeklyConversation, createdAt: oldMessageDate },
      }),
    );
    assert.equal(
      await prisma.message.findFirst({
        where: { conversationId: regularConversation, createdAt: oldMessageDate },
      }),
      null,
    );
  } finally {
    await prisma.message.deleteMany({
      where: { conversationId: { in: [weeklyConversation, regularConversation] } },
    });
    await prisma.conversation.deleteMany({
      where: { id: { in: [weeklyConversation, regularConversation] } },
    });
  }
});
