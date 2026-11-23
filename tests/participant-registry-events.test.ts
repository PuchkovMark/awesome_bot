import { expect, test, vi } from 'vitest';
import { createChatQueue, createMessageRouter } from '../src/core/index';
import type { ChatId, IncomingMessage, MembershipEvent } from '../src/contracts/index';
import { participantRegistryStore } from '../src/storage/participant-registry';
import { departureGraceMs } from '../src/storage/participant-departures';
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

test('повторы не продлевают срок, два ухода разделены, поздний возврат начинает новый профиль', async () => {
  const files = storageFixture();
  const started = Date.UTC(2026, 10, 23);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(started);
  let storage = await openStorage(files.path);
  try {
    let registry = participantRegistryStore(storage);
    let scope = scopeFor(storage, left);
    registry.observe(scope, event(left, 'joined', started - 1), '1');
    registry.observe(scope, event(left, 'left', started), '2');
    const first = registry.departure(scope, anna);
    expect(first).toMatchObject({ departedAt: started, returnedAt: null, profileEpoch: 0 });
    expect(registry.observe(scope, event(left, 'left', started), '2')).toBe(false);
    registry.observe(scope, event(left, 'removed', started + 1), '3');
    expect(registry.departure(scope, anna)).toEqual(first);
    expect(registry.departure(scopeFor(storage, right), anna)).toBeUndefined();

    await storage.close();
    const early = started + departureGraceMs - 1;
    clock.mockReturnValue(early);
    storage = await openStorage(files.path);
    registry = participantRegistryStore(storage);
    scope = scopeFor(storage, left);
    registry.observe(scope, event(left, 'joined', early), '4');
    expect(registry.departure(scope, anna)).toMatchObject({
      departedAt: started,
      returnedAt: early,
      purgedAt: null,
      profileEpoch: 0,
    });

    const second = early + 1;
    registry.observe(scope, event(left, 'removed', second), '5');
    expect(registry.departure(scope, anna)).toMatchObject({ departedAt: second, returnedAt: null });
    const deadline = second + departureGraceMs;
    clock.mockReturnValue(deadline);
    registry.observe(scope, event(left, 'joined', deadline), '6');
    expect(registry.departure(scope, anna)).toMatchObject({
      returnedAt: deadline,
      purgedAt: deadline,
      profileEpoch: expect.any(Number),
    });
    expect(registry.departure(scope, anna)!.profileEpoch).toBeGreaterThan(0);
    expect(registry.observe(scope, event(left, 'removed', second), '5')).toBe(false);
  } finally {
    await storage.close();
    clock.mockRestore();
    files.cleanup();
  }
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
