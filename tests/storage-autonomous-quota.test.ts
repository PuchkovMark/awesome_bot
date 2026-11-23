import { expect, test } from 'vitest';
import { chatLimits } from '../src/core/chat-limits/config';
import type { ChatId } from '../src/contracts/index';
import { openStorage } from '../src/storage/index';
import { queueBackend } from '../src/storage/queue-registry';
import { scopeFor } from './helpers/connection-scope';
import { storageFixture } from './helpers/storage-fixture';

const token = 'active-queue';
const noon = Date.UTC(2026, 10, 23, 12);
const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
const limits = chatLimits({ autonomousPerHour: 1, autonomousPerDay: 2 });

async function active(storage: Awaited<ReturnType<typeof openStorage>>, chatId: ChatId) {
  const scope = scopeFor(storage, chatId);
  await storage.chats.create(scope, { enabled: true, responseMode: 'active', createdAt: 0 });
  return scope;
}

test('12:00 UTC, первая часть в 12:03, час и сутки от резерва, открытая отправка дольше часа', async () => {
  const storage = await openStorage(':memory:');
  try {
    const backend = queueBackend(storage);
    backend.acquire(token, 30_000, 1000);
    const scope = await active(storage, 'vk:chat');
    const quota = backend.autonomousQuota(token, limits, 'vk');
    const offers = await Promise.all([1, 2].map(async () => quota.reserve(scope, noon)));
    expect(offers.filter(Boolean)).toHaveLength(1);
    const reservation = offers.find(Boolean)!;
    const first = quota.beginAttempt(reservation, noon)!;
    expect(quota.confirmPart(reservation, first, noon + 3 * minute)).toBe(true);
    const second = quota.beginAttempt(reservation, noon + 4 * minute)!;

    expect(quota.inspect(scope, noon + 23 * minute)).toMatchObject({
      intervalFrom: noon + 3 * minute, intervalUntil: noon + 23 * minute, daily: 1, open: true,
    });
    expect(quota.inspect(scope, noon + hour - 1)).toMatchObject({ hourly: 1 });
    expect(backend.pruneQuotas(token, limits, 'vk', noon + hour).autonomous).toBe(0);
    expect(quota.inspect(scope, noon + hour)).toMatchObject({ hourly: 0, daily: 1, open: true, allowed: false });
    expect(quota.reserve(scope, noon + hour)).toBeNull();

    expect(quota.confirmPart(reservation, second, noon + hour + 1)).toBe(true);
    expect(quota.finish(reservation)).toBe('delivered');
    expect(quota.inspect(scope, noon + hour + 1)).toMatchObject({
      intervalFrom: noon + 3 * minute, hourly: 0, daily: 1, open: false, allowed: true,
    });
    expect(quota.inspect(scope, noon + day - 1)).toMatchObject({ daily: 1 });
    expect(quota.inspect(scope, noon + day)).toMatchObject({ daily: 0 });
    expect(backend.pruneQuotas(token, limits, 'vk', noon + day).autonomous).toBe(1);
  } finally { await storage.close(); }
});

test('отклонённая попытка освобождает резерв, неизвестная расходует его от момента попытки', async () => {
  const storage = await openStorage(':memory:');
  try {
    const backend = queueBackend(storage);
    backend.acquire(token, 30_000, 1000);
    const quota = backend.autonomousQuota(token, limits, 'vk');
    const scope = await active(storage, 'vk:chat');
    const neighbor = await active(storage, 'vk:neighbor');
    const rejected = quota.reserve(scope, noon)!;
    const first = quota.beginAttempt(rejected, noon)!;
    expect(quota.rejectAttempt(rejected, first)).toBe(true);
    expect(quota.rejectAttempt(rejected, first)).toBe(false);
    expect(quota.finish(rejected)).toBe('released');
    expect(quota.inspect(scope, noon)).toMatchObject({ allowed: true, daily: 0, intervalFrom: null });

    const unknown = quota.reserve(scope, noon)!;
    const attemptedAt = noon + 55 * minute;
    const attempt = quota.beginAttempt(unknown, attemptedAt)!;
    expect(quota.finish(unknown)).toBe('unknown');
    expect(quota.confirmPart(unknown, attempt, attemptedAt + 1)).toBe(false);
    expect(quota.finish(unknown)).toBeNull();
    expect(quota.inspect(scope, noon + hour)).toMatchObject({ open: false, hourly: 0, daily: 1, intervalFrom: attemptedAt, allowed: false });
    expect(quota.reserve(scope, attemptedAt + limits.autonomousIntervalMs - 1)).toBeNull();
    expect(quota.inspect(scope, attemptedAt + limits.autonomousIntervalMs)).toMatchObject({ allowed: true });
    expect(quota.inspect(neighbor, noon + hour)).toMatchObject({ allowed: true, daily: 0, intervalFrom: null });

    await storage.chats.update(neighbor, { responseMode: 'normal' });
    expect(quota.reserve(neighbor, noon + hour)).toBeNull();
    await storage.chats.update(neighbor, { responseMode: 'active' });
    const reserved = quota.reserve(neighbor, noon + hour)!;
    await storage.chats.update(neighbor, { enabled: false });
    expect(quota.beginAttempt(reserved, noon + hour)).toBeNull();
    expect(quota.finish(reserved)).toBe('released');

    await storage.chats.update(neighbor, { enabled: true });
    const pauseEnd = noon + hour + minute;
    await storage.authorization.transaction(neighbor, tx => tx.writePause({
      pausedUntil: pauseEnd, nextParticipantPause: pauseEnd + 15 * minute, autonomousDisabled: false,
    }));
    expect(quota.reserve(neighbor, pauseEnd - 1)).toBeNull();
    expect(quota.inspect(neighbor, pauseEnd).allowed).toBe(true);
    await storage.authorization.transaction(neighbor, tx => tx.writePause({
      pausedUntil: null, nextParticipantPause: null, autonomousDisabled: true,
    }));
    expect(quota.reserve(neighbor, pauseEnd + day)).toBeNull();
  } finally { await storage.close(); }
});

test('суточный лимит держится после освобождения часового окна', async () => {
  const storage = await openStorage(':memory:');
  try {
    const backend = queueBackend(storage);
    backend.acquire(token, 30_000, 1000);
    const scope = await active(storage, 'vk:chat');
    const quota = backend.autonomousQuota(token, limits, 'vk');
    for (const time of [noon, noon + hour]) {
      const reservation = quota.reserve(scope, time)!;
      const attempt = quota.beginAttempt(reservation, time)!;
      expect(quota.confirmPart(reservation, attempt, time)).toBe(true);
      expect(quota.finish(reservation)).toBe('delivered');
    }
    expect(quota.inspect(scope, noon + day - 1)).toMatchObject({ hourly: 0, daily: 2, open: false, allowed: false });
    expect(quota.inspect(scope, noon + day)).toMatchObject({ hourly: 0, daily: 1, open: false, allowed: true });
  } finally { await storage.close(); }
});

test('смена владельца восстанавливает подтверждение, неизвестную попытку и не начатый резерв', async () => {
  const files = storageFixture();
  let storage = await openStorage(files.path);
  try {
    let backend = queueBackend(storage);
    backend.acquire(token, 30_000, 1000);
    const oldQuota = backend.autonomousQuota(token, limits);
    const confirmed = await active(storage, 'vk:confirmed');
    const uncertain = await active(storage, 'vk:uncertain');
    const unused = await active(storage, 'vk:unused');
    const other = await active(storage, 'tg:other');
    const first = oldQuota.reserve(confirmed, noon)!;
    const attempt = oldQuota.beginAttempt(first, noon)!;
    oldQuota.confirmPart(first, attempt, noon + 3 * minute);
    oldQuota.beginAttempt(first, noon + 4 * minute);
    const second = oldQuota.reserve(uncertain, noon)!;
    oldQuota.beginAttempt(second, noon + 2 * minute);
    expect(oldQuota.reserve(unused, noon)).not.toBeNull();
    expect(oldQuota.reserve(other, noon)).not.toBeNull();
    expect(() => backend.acquire('next', 30_000, 1000, undefined, undefined, 'vk')).toThrow('queue_owned');
    expect(oldQuota.inspect(confirmed, noon + 5 * minute).open).toBe(true);

    backend.release(token);
    await storage.close();
    storage = await openStorage(files.path);
    backend = queueBackend(storage);
    backend.acquire('next', 30_000, 1000, undefined, undefined, 'vk');
    const current = backend.autonomousQuota('next', limits, 'vk');
    const read = (chatId: ChatId) => current.inspect(scopeFor(storage, chatId), noon + 5 * minute);
    expect(read(confirmed.chatId)).toMatchObject({ open: false, daily: 1, intervalFrom: noon + 3 * minute });
    expect(read(uncertain.chatId)).toMatchObject({ open: false, daily: 1, intervalFrom: noon + 2 * minute });
    expect(read(unused.chatId)).toMatchObject({ open: false, daily: 0, intervalFrom: null, allowed: true });
    expect(() => read(other.chatId)).toThrow('invalid_input');
    expect(backend.autonomousQuota('next', limits).inspect(scopeFor(storage, other.chatId), noon).open).toBe(true);
    expect(() => backend.autonomousQuota(token, limits).inspect(scopeFor(storage, unused.chatId), noon)).toThrow('queue_lost_ownership');
  } finally {
    await storage.close();
    files.cleanup();
  }
});
