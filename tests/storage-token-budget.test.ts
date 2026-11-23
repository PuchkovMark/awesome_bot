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
      store.update(scope, true, { total: 15000 }, noon);
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
      expect(db.prepare('SELECT count(*) FROM chat_token_budgets').pluck().get()).toBe(0);
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

test('фоновая доля 5% входит в общий остаток, переживает рестарт и меняется вместе с численностью', async () => {
  const files = storageFixture();
  let first = await openStorage(files.path);
  const second = await openStorage(files.path);
  const chat = 'vk:profile-budget';
  try {
    let scope = scopeFor(first, chat);
    const other = scopeFor(second, chat);
    let store = tokenBudgetStore(first);
    const members = Array.from({ length: 20 }, (_, i) => ({
      userId: `vk:${i + 1}` as const,
      role: 'member' as const,
    }));
    const refresh = (people: number, at: number) =>
      store.finishObservation(
        scope,
        store.beginObservation(scope, at),
        { complete: true, people, members: members.slice(0, people) },
        at,
      );
    expect(refresh(20, noon)).toBe(true);
    const initial = store.read(scope, true, noon);
    expect(initial.total.limit).toBe(300_000);
    expect(initial.profileUpdate.limit).toBe(15_000);
    const background = {
      key: 'profile-1',
      purpose: 'profile_update',
      input: 14_900,
      output: 100,
    } as const;
    expect(store.reserve(scope, true, { ...background, input: 14_901 }, noon)).toBe(false);
    expect(store.reserve(scope, true, background, noon)).toBe(true);
    expect(
      tokenBudgetStore(second).reserve(
        other,
        true,
        { ...background, key: 'profile-2', input: 1, output: 0 },
        noon,
      ),
    ).toBe(false);
    expect(store.reserve(scope, true, { ...attempt, input: 285_001, output: 0 }, noon)).toBe(false);
    expect(store.reserve(scope, true, { ...attempt, input: 285_000, output: 0 }, noon)).toBe(true);
    expect(store.reconcile(scope, background.key, { input: null, output: 100 })).toBe(true);
    expect(store.read(scope, true, noon).initiative?.remaining).toBe(10_000);
    expect(refresh(19, noon + 10)).toBe(true);
    await first.close();
    first = await openStorage(files.path);
    scope = scopeFor(first, chat);
    store = tokenBudgetStore(first);
    expect(store.read(scope, true, noon + 10).profileUpdate).toEqual({
      limit: 14_250,
      remaining: 0,
      confirmed: 100n,
      reserved: 14_900n,
      incompleteAttempts: 1,
    });
    expect(store.read(scope, true, noon + tokenBudgetWindowMs).profileUpdate.remaining).toBe(
      14_250,
    );
    expect(
      store.update(scope, false, { total: 319 }, noon + tokenBudgetWindowMs).profileUpdate.limit,
    ).toBe(15);
  } finally {
    await first.close();
    await second.close();
    files.cleanup();
  }
});

test('расширение назначения попыток переносит оплаченную инициативу и резерв прямого ответа', async () => {
  const files = storageFixture();
  const db = new Database(files.path);
  try {
    migrate(db, migrations.slice(0, 39));
    db.prepare(
      "INSERT INTO chat_connections(chat_id,generation,revision,state) VALUES('vk:budget',1,0,'active')",
    ).run();
    db.prepare(
      `INSERT INTO token_budget_attempts VALUES
      ('vk:budget',1,'direct',?,'direct',10,30,8,NULL),
      ('vk:budget',1,'initiative',?,'initiative',20,20,12,4)`,
    ).run(noon, noon);
    migrate(db, migrations);
    expect(
      db
        .prepare(
          'SELECT purpose,input_tokens,output_tokens FROM token_budget_attempts ORDER BY purpose',
        )
        .all(),
    ).toEqual([
      { purpose: 'direct', input_tokens: 8, output_tokens: null },
      { purpose: 'initiative', input_tokens: 12, output_tokens: 4 },
    ]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
    files.cleanup();
  }
});
