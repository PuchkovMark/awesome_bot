import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import type { ConnectionScope, UserId } from '../src/contracts/index.js';
import { chatLimits } from '../src/core/chat-limits/config.js';
import { queueConfig } from '../src/core/chat-queue/validation.js';
import { openStorage } from '../src/storage/index.js';
import { queueBackend } from '../src/storage/queue-registry.js';
import { queueMessage } from './helpers/chat-queue.js';
import { scopeFor } from './helpers/connection-scope.js';
import { storageFixture } from './helpers/storage-fixture.js';

const token = 'test-queue';
const route = () => ({ reason: 'mention', route: { kind: 'mention', mode: 'normal', isGroupChat: true } } as const);
const config = queueConfig({});
const settings = { enabled: true, responseMode: 'normal', createdAt: 0 } as const;
const limits = chatLimits({ userRequests: 1, chatRequests: 2, userWindowMs: 1000, chatWindowMs: 2000 });

test('две квоты считают одну запись и освобождают места на собственных границах', async () => {
  const files = storageFixture();
  const storage = await openStorage(files.path);
  const db = new Database(files.path);
  const backend = queueBackend(storage);
  try {
    backend.acquire(token, 30_000, 1000);
    const first = scopeFor(storage, 'vk:first');
    const other = scopeFor(storage, 'vk:other');
    for (const scope of [first, other]) await storage.chats.create(scope, settings);
    let next = 0;
    function check(scope: ConnectionScope, userId: UserId, time: number) {
      const message = { ...queueMessage(scope.chatId, String(++next)), userId };
      expect(backend.admitRouted(token, scope, message, route, config).admission.status).toBe('queued');
      const work = backend.take(token)!;
      const result = backend.admitModelAttempt(token, work, limits, () => true, () => time);
      backend.finish(token, work, result === true ? 'completed' : 'failed');
      expect(backend.admitRouted(token, scope, message, route, config).admission.status).toBe('duplicate');
      return result;
    }
    expect(check(first, 'vk:a', 1000)).toBe(true);
    expect(check(first, 'vk:a', 1001)).toBe('quota_exhausted');
    expect(check(first, 'vk:b', 1002)).toBe(true);
    expect(check(first, 'vk:c', 1003)).toBe('quota_exhausted');
    expect(check(other, 'vk:a', 1003)).toBe(true);
    expect(check(first, 'vk:a', 2999)).toBe('quota_exhausted');
    expect(check(first, 'vk:a', 3000)).toBe(true);
    expect(db.prepare('SELECT job_id,admitted_at FROM request_quota_admissions ORDER BY job_id').all())
      .toEqual([{ job_id: 1, admitted_at: 1000 }, { job_id: 3, admitted_at: 1002 },
        { job_id: 5, admitted_at: 1003 }, { job_id: 7, admitted_at: 3000 }]);
  } finally {
    db.close();
    await storage.close();
    files.cleanup();
  }
});

test('проверка перед допуском, повтор после окна и перезапуск не расходуют лишнее', async () => {
  const files = storageFixture();
  let storage = await openStorage(files.path);
  const db = new Database(files.path);
  try {
    let backend = queueBackend(storage);
    backend.acquire(token, 30_000, 1000);
    const scope = scopeFor(storage, 'vk:chat');
    await storage.chats.create(scope, settings);
    backend.admitRouted(token, scope, queueMessage(scope.chatId, '1'), route, config);
    const work = backend.take(token)!;
    expect(backend.admitModelAttempt(token, work, limits, () => false, () => 1000)).toBe(false);
    expect(db.prepare('SELECT * FROM request_quota_admissions').all()).toEqual([]);
    expect(backend.admitModelAttempt(token, work, limits, () => true, () => 1000)).toBe(true);
    expect(backend.pruneQuotas(token, limits, 'vk', 3000).requests).toBe(0);
    expect(backend.admitModelAttempt(token, work, limits, () => true, () => 3000)).toBe(true);
    expect(db.prepare('SELECT admitted_at FROM request_quota_admissions').all()).toEqual([{ admitted_at: 1000 }]);
    backend.release(token);
    await storage.close();
    storage = await openStorage(files.path);
    backend = queueBackend(storage);
    expect(backend.acquire('next', 30_000, 1000)).toBe(1);
    const current = scopeFor(storage, scope.chatId);
    expect(await storage.queue.get(current, work.id)).toMatchObject({ outcome: 'interrupted' });
    db.pragma('foreign_keys=ON');
    db.prepare('DELETE FROM queue_jobs WHERE id=?').run(work.id);
    expect(db.prepare('SELECT admitted_at FROM request_quota_admissions').all()).toEqual([{ admitted_at: 1000 }]);
    expect(backend.pruneQuotas('next', limits, 'vk', 2999).requests).toBe(0);
    expect(backend.pruneQuotas('next', limits, 'vk', 3000).requests).toBe(1);
  } finally {
    db.close();
    await storage.close();
    files.cleanup();
  }
});
