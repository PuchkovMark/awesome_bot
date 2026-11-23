import { expect, test } from 'vitest';
import { createChatQueue, createMessageRouter } from '../src/core/index';
import type { ChatId, IncomingMessage, MembershipEvent } from '../src/contracts/index';
import { participantRegistryStore } from '../src/storage/participant-registry';
import { openStorage, scopeFor } from './helpers/connection-scope';
import { storageFixture } from './helpers/storage-fixture';

const left = 'vk:2000000001';
const right = 'vk:2000000002';
const anna = 'vk:41';
const event = (
  chatId: ChatId,
  change: MembershipEvent['change'],
  timestamp: number,
): MembershipEvent => ({
  kind: 'membership',
  chatId,
  change,
  timestamp,
  actorId: 'vk:42',
  subjectId: anna,
});

test('участие, спорные события и дедупликация сохраняются в пределах поколения', async () => {
  const files = storageFixture();
  let storage = await openStorage(files.path);
  try {
    let registry = participantRegistryStore(storage);
    let first = scopeFor(storage, left);
    let second = scopeFor(storage, right);
    expect(registry.observe(first, event(left, 'invited', 10), '1')).toBe(true);
    expect(registry.read(first).participants).toEqual([]);
    expect(registry.observe(first, event(left, 'joined', 20), '2')).toBe(true);
    expect(registry.observe(first, event(left, 'removed', 30), '3')).toBe(true);
    expect(registry.observe(first, event(left, 'joined', 25), '4')).toBe(false);
    expect(registry.observe(first, event(left, 'left', 30), '5')).toBe(true);
    expect(registry.observe(second, event(right, 'left', 30), '3')).toBe(true);
    expect(registry.read(first).participants).toMatchObject([
      { status: 'removed', statusObservedAt: 30, joinedAt: 20 },
    ]);
    expect(registry.read(second).participants).toMatchObject([
      { status: 'left', statusObservedAt: 30, joinedAt: null },
    ]);
    const revision = registry.read(first).revision;
    await storage.close();
    storage = await openStorage(files.path);
    registry = participantRegistryStore(storage);
    first = scopeFor(storage, left);
    second = scopeFor(storage, right);
    expect(registry.observe(first, event(left, 'removed', 30), '3')).toBe(false);
    expect(registry.read(first).revision).toBe(revision);
    expect(registry.observe(first, event(left, 'joined', 40), '6')).toBe(true);
    expect(registry.read(first).participants).toMatchObject([
      { userId: anna, status: 'present', joinedAt: 40, role: 'unknown' },
    ]);
    expect(registry.read(second).participants).toMatchObject([{ userId: anna, status: 'left' }]);
  } finally {
    await storage.close();
    files.cleanup();
  }
});

test('журнал уточняет только максимум времени допуска сообщения человека', async () => {
  const storage = await openStorage(':memory:');
  const queue = createChatQueue({
    storage,
    tracing: { messageRetentionDays: 30 },
    async handler() {
      return 'completed';
    },
  });
  try {
    await queue.start();
    const router = createMessageRouter({ storage, queue });
    const first = scopeFor(storage, left),
      second = scopeFor(storage, right);
    const registry = participantRegistryStore(storage);
    const send = (id: string, timestamp: number, isBot: IncomingMessage['isBot'] = false) =>
      router.receive(first, {
        kind: 'message',
        chatId: left,
        userId: anna,
        messageId: id,
        timestamp,
        isBot,
        authorName: 'Анна',
        isGroupChat: true,
        isAdmin: true,
        isMentioned: false,
        isReplyToBot: false,
        text: 'Общий разговор',
        attachments: [],
      });
    await send('1', 100);
    await send('2', 20);
    await send('1', 300);
    await send('3', 700, true);
    await send('4', 900, 'unknown');
    expect(registry.read(first).participants).toEqual([
      {
        chatId: left,
        userId: anna,
        joinedAt: null,
        status: 'unknown',
        statusObservedAt: null,
        role: 'unknown',
        roleObservedAt: null,
        lastSeenAt: 100,
      },
    ]);
    expect(registry.read(second).participants).toEqual([]);
  } finally {
    await queue.stop();
    await storage.close();
  }
});
