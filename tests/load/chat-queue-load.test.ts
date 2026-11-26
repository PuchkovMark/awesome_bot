import { recordQueueLoad } from '../helpers/queue-load-fixture';
import { expect, test, vi } from 'vitest';
import { openStorage } from '../../src/storage/index';
import { createChatQueue } from '../../src/core/index';
import { queueConfig } from '../../src/core/chat-queue/validation';
import { queueBackend } from '../../src/storage/queue-registry';
import { scopeFor } from '../helpers/connection-scope';
import { queueMessage, flushQueue } from '../helpers/chat-queue';
import { storageFixture } from '../helpers/storage-fixture';
import type { LlmResult } from '../../src/llm/types';
import { answer, fixture, mention, peer, until } from '../helpers/application-response-fixture';
test('расчётная модель: 4 слота, 130 секунд, 8 ожидающих, тихий чат при полном допуске', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(10000);
  const storage = await openStorage(':memory:');
  let calls = 0,
    completed = 0;
  const scopes = ['vk:a', 'vk:b', 'vk:c', 'vk:d'].map((id) => scopeFor(storage, id));
  const backend = queueBackend(storage);
  backend.acquire('seed', 30000, 10000);
  for (const scope of scopes)
    for (let i = 0; i < 2; i++)
      backend.admit(
        'seed',
        scope,
        queueMessage(scope.chatId, String(i)),
        () => true,
        queueConfig(),
      );
  backend.release('seed');
  const q = createChatQueue({
    tracing: { messageRetentionDays: 30 },
    storage,
    handler: async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 129000));
      completed++;
      return 'completed';
    },
  });
  try {
    await q.start();
    await flushQueue();
    for (const scope of scopes) await q.admit(scope, queueMessage(scope.chatId, 'new'), () => true);
    expect(q.stats()).toMatchObject({ depthRunning: 4, depthQueued: 8 });
    const quiet = scopeFor(storage, 'vk:quiet');
    expect((await q.admit(quiet, queueMessage('vk:quiet', 'full'), () => true)).status).toBe(
      'queue_full',
    );
    await vi.advanceTimersByTimeAsync(390000);
    expect(calls).toBe(12);
    expect(completed).toBe(12);
    expect(q.stats()).toMatchObject({ depthRunning: 0, depthQueued: 0, expired: 0, rejected: 1 });
    expect(q.stats().waitMaxMs).toBeLessThan(600000);
    await recordQueueLoad({
      model: true,
      completed: 12,
      modelElapsedMs: 390000,
      modelThroughputPerMinute: 12 / (390000 / 60000),
      waitMaxMs: q.stats().waitMaxMs,
    });
  } finally {
    await q.stop();
    await storage.close();
    vi.useRealTimers();
  }
});
test('реальная SQLite: всплеск, ограниченная вместимость, журнал независимо от допуска', async () => {
  const f = storageFixture(),
    storage = await openStorage(f.path);
  let completed = 0;
  const q = createChatQueue({
    tracing: { messageRetentionDays: 30 },
    storage,
    handler: async () => {
      await new Promise((r) => setTimeout(r, 1));
      completed++;
      return 'completed';
    },
  });
  try {
    await q.start();
    const started = performance.now();
    let rejected = 0;
    const scopes = Array.from({ length: 20 }, (_, i) => scopeFor(storage, `vk:${i}`));
    for (let i = 0; i < 500; i++) {
      const s = scopes[i % 20]!;
      if ((await q.admit(s, queueMessage(s.chatId, String(i)), () => true)).status === 'queue_full')
        rejected++;
    }
    const deadline = performance.now() + 10000;
    while (q.stats().depthRunning + q.stats().depthQueued) {
      if (performance.now() > deadline) throw Error('load_timeout');
      await new Promise((r) => setTimeout(r, 10));
    }
    const elapsedMs = performance.now() - started;
    expect(completed + rejected).toBe(500);
    expect(rejected).toBeGreaterThan(0);
    let journal = 0;
    for (const s of scopes) journal += (await storage.messages.list(s, { limit: 500 })).length;
    expect(journal).toBe(500);
    await recordQueueLoad({
      model: false,
      sqlite: true,
      submitted: 500,
      completed,
      rejected,
      journal,
      elapsedMs,
      waitMaxMs: q.stats().waitMaxMs,
    });
  } finally {
    await q.stop();
    await storage.close();
    f.cleanup();
  }
});

test('медленная оценка под всплеском освобождает просроченные ожидания и пропускает VK-упоминание', async () => {
  const f = await fixture({ active: true });
  const slow = Promise.withResolvers<LlmResult>();
  f.assess.mockImplementationOnce(() => slow.promise);
  try {
    const other = await f.connectGroup(peer + 1);
    const pending = f.submit('На столе три настолки, всё никак не выберем первую');
    await until(() => expect(f.assess).toHaveBeenCalledOnce());
    for (let i = 0; i < 24; i++)
      f.submit(`Пенёк, помоги с задачей ${i}`, 41, undefined, peer + (i % 2));
    const direct = f.submit(mention, 41, undefined, peer + 1);
    await f.published(direct);
    await f.journaled(f.submit('Контрольная отметка в журнале', -1));
    expect(
      f.db
        .prepare(`SELECT count(*) FROM group_reply_assessments WHERE state IN ('waiting','sent')`)
        .pluck()
        .get(),
    ).toBe(4);
    expect(
      f.db
        .prepare(
          "SELECT count(*) FROM messages WHERE role='user' AND text LIKE '%помоги с задачей%'",
        )
        .pluck()
        .get(),
    ).toBe(24);
    expect(f.complete).toHaveBeenCalledOnce();
    expect(f.sends.at(-1)?.peer_id).toBe(peer + 1);
    f.at(120_001);
    slow.resolve({ ...answer, text: 'ответить' });
    await until(() =>
      expect(
        f.db
          .prepare("SELECT count(*) FROM group_reply_assessments WHERE outcome='expired'")
          .pluck()
          .get(),
      ).toBe(3),
    );
    expect(f.assess).toHaveBeenCalledOnce();
    expect(f.sends.some((row) => row.reply_message?.conversation_message_id === pending)).toBe(
      false,
    );
    await f.published(f.submit('Пенёк, подскажи', 41, undefined, peer + 1));
    expect(f.assess).toHaveBeenCalledTimes(2);
    expect(f.complete).toHaveBeenCalledTimes(2);
    expect(f.sends.at(-1)?.peer_id).toBe(peer + 1);
    expect((await f.storage.messages.list(other, { limit: 30 })).length).toBeGreaterThan(12);
  } finally {
    slow.resolve(answer);
    await f.close();
  }
});
