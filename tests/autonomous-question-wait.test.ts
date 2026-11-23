import { expect, test, vi } from 'vitest';
import { createChatQueue, createLifecycleService, createMessageRouter } from '../src/core/index';
import type { QueueHandlerInput } from '../src/core/index';
import { openStorage } from '../src/storage/index';
import { openConnection } from '../src/storage/connection';
import { storageFixture } from './helpers/storage-fixture';
import { flushQueue } from './helpers/chat-queue';
import type { IncomingMessage } from '../src/contracts/index';

const noon = Date.UTC(2026, 10, 23, 12);
const chatId = 'vk:2000000001';
const owner = 'vk:73';
const event = (
  messageId: string,
  text: string,
  timestamp: number,
  extra: Partial<IncomingMessage> = {},
): IncomingMessage => ({
  kind: 'message',
  chatId,
  userId: 'vk:45',
  authorName: 'Тест',
  isGroupChat: true,
  isBot: false,
  isAdmin: false,
  isMentioned: false,
  isReplyToBot: false,
  messageId,
  text,
  timestamp,
  attachments: [],
  ...extra,
});

async function fixture() {
  const files = storageFixture();
  const storage = await openStorage(files.path);
  const db = await openConnection(files.path);
  const life = createLifecycleService({
    storage,
    ownerId: owner,
    source: {
      async observe() {
        return { confidence: 'confirmed', bot: 'present' };
      },
    },
  });
  let now = noon - 1000;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const opened = (await life.verify(chatId)).scope!;
  await storage.chats.create(opened, { enabled: true, responseMode: 'active', createdAt: now });
  const handler = vi.fn<(work: QueueHandlerInput) => Promise<'completed'>>(async () => 'completed');
  const makeQueue = (platform?: string) =>
    createChatQueue({
      storage,
      handler,
      autonomousReplies: true,
      tracing: { messageRetentionDays: 30 },
      config: { leaseMs: 600_000, renewIntervalMs: 10_000 },
      ...(platform ? { platform } : {}),
    });
  let queue = makeQueue();
  await queue.start();
  return {
    storage,
    handler,
    life,
    db,
    async send(message: IncomingMessage) {
      return createMessageRouter({ storage, queue }).receive(life.admissionScope(chatId), message);
    },
    async at(time: number) {
      now = time;
      queue.wakeHistoryMaintenance?.();
      await flushQueue();
    },
    async restart(platform?: string) {
      await queue.stop();
      queue = makeQueue(platform);
      await queue.start();
    },
    async close() {
      try {
        await queue.stop();
      } finally {
        clock.mockRestore();
        db.close();
        await storage.close();
        files.cleanup();
      }
    },
  };
}

test('ожидание остаётся вне очереди и после короткого рестарта допускает вопрос ровно через две минуты', async () => {
  const f = await fixture();
  try {
    const source = await f.send(event('source', 'Встречаемся у фонтана в 18:30.', noon - 1000));
    await f.at(noon);
    const q = event('question', 'Во сколько встречаемся у фонтана?', noon);
    expect((await f.send(q)).decision).toMatchObject({ initiative: 'unanswered' });
    expect((await f.send(q)).admission?.status).toBe('duplicate');
    await f.at(noon + 119999);
    expect(f.handler).not.toHaveBeenCalled();
    expect(f.db.run((db) => db.prepare('SELECT 1 FROM queue_jobs').all())).toEqual([]);
    expect(
      f.db.run((db) => db.prepare('SELECT eligible_at,expires_at FROM autonomous_questions').all()),
    ).toEqual([{ eligible_at: noon + 120000, expires_at: noon + 300000 }]);
    await f.restart();
    await f.at(noon + 120000);
    await vi.waitFor(() => expect(f.handler).toHaveBeenCalledOnce());
    expect(f.handler.mock.calls[0]?.[0]).toMatchObject({
      route: { kind: 'initiative', cause: 'unanswered' },
      initiativeEvidenceId:
        source.admission?.status === 'not_needed' ? source.admission.messageId : undefined,
    });
    await f.at(noon + 120001);
    expect(f.handler).toHaveBeenCalledOnce();
    expect(f.db.run((db) => db.prepare('SELECT 1 FROM autonomous_questions').all())).toEqual([]);
  } finally {
    await f.close();
  }
});

test.each(['ответ', 'конфликт', 'удаление', 'истечение', 'пауза VK'] as const)(
  'отложенный повод даёт молчание при условии %s',
  async (condition) => {
    const f = await fixture();
    try {
      await f.send(event('source', 'Встречаемся у фонтана в 18:30.', noon - 1000));
      if (condition === 'конфликт')
        await f.send(event('conflict', 'Встречаемся у фонтана в 19:00.', noon - 1000));
      await f.at(noon);
      await f.send(event('question', 'Во сколько встречаемся у фонтана?', noon));
      await f.at(noon + 1000);
      if (condition === 'ответ')
        await f.send(
          event('answer', 'Я помню, в 18:30.', noon + 1000, {
            userId: 'vk:46',
            replyAddress: 'other',
            replyToMessageId: 'question',
          }),
        );
      if (condition === 'удаление')
        f.db.run((db) =>
          db.prepare("DELETE FROM messages WHERE platform_message_id='source'").run(),
        );
      if (condition === 'пауза VK') await f.restart('vk');
      await f.at(noon + (condition === 'истечение' ? 300000 : 120000));
      expect(f.handler).not.toHaveBeenCalled();
      if (condition === 'ответ' || condition === 'конфликт' || condition === 'удаление') {
        expect(
          (await f.storage.traces.get(f.life.current(chatId), 1))?.payload.publication,
        ).toMatchObject({
          status: 'suppressed',
          reason: condition === 'ответ' ? 'initiative_answered' : 'initiative_source',
        });
      }
    } finally {
      await f.close();
    }
  },
);
