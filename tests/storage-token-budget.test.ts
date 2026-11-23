import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { openStorage } from '../src/storage/index';
import { migrate } from '../src/storage/migrate';
import { migrations } from '../src/storage/migrations/index';
import { tokenBudgetStore, tokenBudgetWindowMs } from '../src/storage/token-budget-store';
import { lifecycleBackend } from '../src/storage/lifecycle-store';
import { scopeFor } from './helpers/connection-scope';
import { storageFixture } from './helpers/storage-fixture';

const noon = Date.parse('2026-11-23T12:00:00Z');
const attempt = { key: 'job:1:1', purpose: 'direct', input: 1000, output: 500 } as const;

test('обновление с 019 и независимость расхода от журнала и трассировок', async () => {
  const fixture = storageFixture();
  const db = new Database(fixture.path);
  try {
    migrate(db, migrations.slice(0, 19));
    db.exec(`INSERT INTO chat_connections(chat_id,generation,revision,state) VALUES('vk:budget',1,0,'active');
      UPDATE lifecycle_clock SET value=1;
      INSERT INTO chats(chat_id,enabled,response_mode,created_at,timezone) VALUES('vk:budget',1,'normal',0,'UTC');`);
    const previous = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    let storage = await openStorage(fixture.path);
    try {
      const scope = scopeFor(storage, 'vk:budget');
      const store = tokenBudgetStore(storage);
      expect(store.read(scope, true, noon).total.limit).toBe(15000);
      expect(store.reserve(scope, true, attempt, noon)).toBe(true);
      store.reconcile(scope, attempt.key, { input: 2000, output: 0 });
      db.exec('DELETE FROM response_traces; DELETE FROM queue_jobs; DELETE FROM messages;');
      expect(
        db.prepare('SELECT * FROM schema_migrations WHERE version<=19 ORDER BY version').all(),
      ).toEqual(previous);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      await storage.close();
      storage = await openStorage(fixture.path);
      const reopened = tokenBudgetStore(storage);
      const current = scopeFor(storage, 'vk:budget');
      expect(reopened.read(current, true, noon + tokenBudgetWindowMs - 1).total).toEqual({
        limit: 15000,
        remaining: 13000,
        confirmed: 2000n,
        reserved: 0n,
        incompleteAttempts: 0,
      });
      expect(reopened.read(current, true, noon + tokenBudgetWindowMs).total.remaining).toBe(15000);
      expect(reopened.read(scopeFor(storage, 'vk:neighbour'), true, noon).total.remaining).toBe(
        15000,
      );
      const life = lifecycleBackend(storage);
      const replacement = life.ownerDecision(life.begin(current.chatId), 'new');
      expect(reopened.read(replacement, true, noon).total.remaining).toBe(15000);
      expect(() => reopened.read(current, true, noon)).toThrow('stale_scope');
      expect(db.prepare('SELECT count(*) FROM token_budget_attempts').pluck().get()).toBe(0);
    } finally {
      await storage.close();
    }
  } finally {
    db.close();
    fixture.cleanup();
  }
});

test('раздельные резервы, нулевая и поздняя сверка, защита от повторного списания', async () => {
  const storage = await openStorage(':memory:');
  try {
    const store = tokenBudgetStore(storage);
    const scope = scopeFor(storage, 'vk:test');
    store.update(scope, true, { total: 1500 }, noon);
    expect(store.reserve(scope, true, { ...attempt, input: 1001 }, noon)).toBe(false);
    expect(store.reserve(scope, true, attempt, noon)).toBe(true);
    expect(store.reserve(scope, true, attempt, noon)).toBe(false);
    expect(
      store.reserve(scope, true, { ...attempt, key: 'other', input: 0, output: 1 }, noon),
    ).toBe(false);
    const snapshot = () => store.read(scope, true, noon + 3 * 60_000).total;
    expect(snapshot()).toMatchObject({ confirmed: 0n, reserved: 1500n, incompleteAttempts: 1 });
    store.reconcile(scope, attempt.key, { input: 0, output: null });
    expect(snapshot()).toMatchObject({ confirmed: 0n, reserved: 500n, incompleteAttempts: 1 });
    store.reconcile(scope, attempt.key, { input: 7, output: 1600 });
    store.reconcile(scope, attempt.key, { input: 8, output: 2000 });
    expect(snapshot()).toMatchObject({
      confirmed: 1600n,
      reserved: 0n,
      remaining: 0,
      incompleteAttempts: 0,
    });
    expect(store.read(scope, true, noon + tokenBudgetWindowMs).total.remaining).toBe(1500);
  } finally {
    await storage.close();
  }
});
