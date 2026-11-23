import Database from 'better-sqlite3';
import { test, expect } from 'vitest';
import { openStorage } from '../src/storage/index';
import { queueBackend } from '../src/storage/queue-registry';
import { tokenBudgetStore, type FinalBudget } from '../src/storage/token-budget-store';
import { queueConfig } from '../src/core/chat-queue/validation';
import { chatLimits } from '../src/core/chat-limits/config';
import { storageFixture } from './helpers/storage-fixture';
import { scopeFor } from './helpers/connection-scope';
import { queueMessage } from './helpers/chat-queue';
test('две ветви делят остаток, финал использует резерв, перезапуск очищает только неиспользованный остаток', async () => {
  const f = storageFixture();
  let storage = await openStorage(f.path);
  const db = new Database(f.path);
  try {
    const backend = queueBackend(storage);
    const scope = scopeFor(storage, 'vk:first');
    await storage.chats.create(scope, { enabled: true, responseMode: 'normal', createdAt: 0 });
    const store = tokenBudgetStore(storage);
    const now = Date.now();
    store.update(scope, true, { total: 120 }, now);
    backend.acquire('test', 30000, 1000);
    const route = () =>
      ({
        reason: 'mention',
        route: { kind: 'mention', mode: 'normal', isGroupChat: true },
      }) as const;
    function start(id: string) {
      backend.admitRouted('test', scope, queueMessage(scope.chatId, id), route, queueConfig({}));
      return backend.take('test')!;
    }
    let work = start('one');
    const limits = chatLimits({});
    function take(key: string, input: number, final?: FinalBudget) {
      return backend.admitModelAttempt(
        'test',
        work,
        limits,
        () => true,
        () => now,
        [],
        undefined,
        { purpose: 'direct', key, input, output: 0 },
        final,
      );
    }
    expect(typeof take('main', 10)).toBe('object');
    expect(typeof take('a', 30, { protect: 80 })).toBe('object');
    expect(take('a-retry', 30, { protect: 80 })).toBe('token_budget_exhausted');
    expect(take('b', 30, { protect: 80 })).toBe('token_budget_exhausted');
    expect(store.read(scope, true, now).total).toMatchObject({
      reserved: 120n,
      incompleteAttempts: 2,
    });
    expect(typeof take('final', 80, 'consume')).toBe('object');
    expect(store.read(scope, true, now).total).toMatchObject({
      reserved: 120n,
      incompleteAttempts: 3,
    });
    expect(db.prepare('select count(*) from request_quota_admissions').pluck().get()).toBe(1);
    backend.finish('test', work, 'failed');
    store.update(scope, true, { total: 250 }, now);
    work = start('two');
    expect(typeof take('unconfirmed', 30, { protect: 100 })).toBe('object');
    expect(store.read(scope, true, now).total.reserved).toBe(250n);
    await storage.close();
    storage = await openStorage(f.path);
    db.prepare('UPDATE queue_lease SET expires_at=0').run();
    queueBackend(storage).acquire('recovery', 30000, 1000);
    expect(
      tokenBudgetStore(storage).read(scopeFor(storage, 'vk:first'), true, now).total,
    ).toMatchObject({ reserved: 150n, incompleteAttempts: 4 });
  } finally {
    db.close();
    await storage.close();
    f.cleanup();
  }
});
