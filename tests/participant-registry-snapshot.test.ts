import { expect, test } from 'vitest';
import type { HumanMembership, UserId } from '../src/contracts/index';
import { openConnection } from '../src/storage/connection';
import { lifecycleBackend } from '../src/storage/lifecycle-store';
import { participantRegistryStore } from '../src/storage/participant-registry';
import { migrate } from '../src/storage/migrate';
import { migrations } from '../src/storage/migrations/index';
import { tokenBudgetStore } from '../src/storage/token-budget-store';
import { openStorage, scopeFor } from './helpers/connection-scope';
import { storageFixture } from './helpers/storage-fixture';

const group = 'vk:2000000041';
const anna = 'vk:41';
const boris = 'vk:42';
const now = Date.UTC(2026, 10, 23, 12);
const full = (...ids: UserId[]): HumanMembership => ({
  complete: true,
  people: ids.length,
  members: ids.map((userId) => ({ userId, role: userId === anna ? 'admin' : 'unknown' })),
});

test('только принятая полная сверка начинает отсчёт при доказанном прежнем присутствии', async () => {
  const files = storageFixture();
  const storage = await openStorage(files.path);
  const connection = await openConnection(files.path);
  try {
    const scope = scopeFor(storage, group);
    const budget = tokenBudgetStore(storage);
    const registry = participantRegistryStore(storage);
    const snapshot = (at: number, membership: HumanMembership) =>
      budget.finishObservation(scope, budget.beginObservation(scope, at), membership, at + 1);
    expect(snapshot(now, full(anna))).toBe(true);
    connection.run((db) => {
      db.prepare(
        "INSERT INTO chat_participants (chat_id,user_id,role,status) VALUES(?,?,'unknown','unknown')",
      ).run(group, boris);
    });
    expect(snapshot(now + 2, { complete: false })).toBe(false);
    expect(registry.departure(scope, anna)).toBeUndefined();
    const stale = budget.beginObservation(scope, now + 4);
    expect(snapshot(now + 5, full())).toBe(true);
    expect(budget.finishObservation(scope, stale, full(anna), now + 7)).toBe(false);
    expect(snapshot(now + 8, full())).toBe(true);
    expect(registry.departure(scope, anna)).toMatchObject({
      departedAt: now + 6,
      returnedAt: null,
    });
    expect(registry.departure(scope, boris)).toBeUndefined();
  } finally {
    connection.close();
    await storage.close();
    files.cleanup();
  }
});

test('миграция сохраняет время явного ухода, историческое отсутствие ждёт полной сверки', async () => {
  const files = storageFixture();
  const previous = await openConnection(files.path, (db) => migrate(db, migrations.slice(0, 36)));
  try {
    previous.run((db) => {
      db.prepare(
        "INSERT INTO chat_connections(chat_id,generation,revision,state) VALUES(?,1,0,'active')",
      ).run(group);
      db.prepare('UPDATE lifecycle_clock SET value=1').run();
      db.prepare(
        "INSERT INTO chats(chat_id,response_mode,timezone,enabled,created_at) VALUES(?,'normal','UTC',1,?)",
      ).run(group, now - 100);
      const insert = db.prepare(
        "INSERT INTO chat_participants(chat_id,user_id,role,status,status_observed_at) VALUES(?,?,'member',?,?)",
      );
      insert.run(group, anna, 'absent', now - 60);
      insert.run(group, boris, 'left', now - 50);
    });
    const storage = await openStorage(files.path);
    try {
      const scope = scopeFor(storage, group);
      const budget = tokenBudgetStore(storage);
      const registry = participantRegistryStore(storage);
      expect(registry.departure(scope, anna)).toMatchObject({ departedAt: null, returnedAt: null });
      expect(registry.departure(scope, boris)).toMatchObject({ departedAt: now - 50 });
      expect(
        budget.finishObservation(
          scope,
          budget.beginObservation(scope, now),
          { complete: false },
          now,
        ),
      ).toBe(false);
      expect(registry.departure(scope, anna)?.departedAt).toBeNull();
      expect(
        budget.finishObservation(scope, budget.beginObservation(scope, now + 1), full(), now + 2),
      ).toBe(true);
      expect(registry.departure(scope, anna)?.departedAt).toBe(now + 2);
      expect(registry.departure(scope, boris)?.departedAt).toBe(now - 50);
    } finally {
      await storage.close();
    }
  } finally {
    previous.close();
    files.cleanup();
  }
});

test('исключение Анны между страницами сохраняется, следующий снимок уточняет отсутствие', async () => {
  const files = storageFixture();
  let storage = await openStorage(files.path);
  try {
    let registry = participantRegistryStore(storage);
    let budget = tokenBudgetStore(storage);
    let scope = scopeFor(storage, group);
    const first = budget.beginObservation(scope, now - 5000);
    expect(budget.finishObservation(scope, first, full(anna, boris), now - 4000)).toBe(true);
    budget.update(scope, true, { total: 456_000, initiative: 8000 }, now);
    budget.reserve(scope, true, { key: 'first', input: 10, output: 10, purpose: 'direct' }, now);
    budget.reconcile(scope, 'first', { input: 10, output: 10 });
    const old = budget.beginObservation(scope, now);
    registry.observe(scope, {
      kind: 'membership',
      chatId: group,
      subjectId: anna,
      actorId: boris,
      change: 'removed',
      timestamp: now + 60_000,
      eventId: 'exclusion',
    });
    expect(budget.finishObservation(scope, old, full(anna, boris), now + 120_000)).toBe(false);
    expect(registry.read(scope)).toMatchObject({
      lastAttemptAt: now,
      lastAttemptComplete: false,
      lastCompleteAt: now - 4000,
      needsSync: true,
      participants: [
        { userId: anna, status: 'removed' },
        { userId: boris, status: 'present' },
      ],
    });
    expect(budget.read(scope, true, now + 120_000).people).toBe(2);
    const next = budget.beginObservation(scope, now + 120_001);
    expect(budget.finishObservation(scope, next, full(), now + 120_001)).toBe(true);
    expect(registry.read(scope).participants).toMatchObject([
      { userId: anna, status: 'removed', statusObservedAt: now + 60_000 },
      { userId: boris, status: 'absent', joinedAt: null },
    ]);
    await storage.close();
    storage = await openStorage(files.path);
    registry = participantRegistryStore(storage);
    budget = tokenBudgetStore(storage);
    scope = scopeFor(storage, group);
    expect(registry.read(scope)).toMatchObject({
      lastAttemptComplete: true,
      lastCompleteAt: now + 120_001,
      needsSync: false,
    });
    expect(budget.read(scope, true, now + 120_001)).toMatchObject({
      people: 0,
      total: { limit: 456_000, remaining: 455_980 },
      initiative: { limit: 8000 },
    });
    const returned = budget.beginObservation(scope, now + 120_002);
    expect(budget.finishObservation(scope, returned, full(anna), now + 120_003)).toBe(true);
    expect(registry.read(scope).participants[0]).toMatchObject({
      userId: anna,
      status: 'present',
      joinedAt: null,
      role: 'admin',
    });
    expect(await storage.authorization.transaction(scope, (tx) => tx.bases(anna))).toEqual([]);
  } finally {
    await storage.close();
    files.cleanup();
  }
});

test('новая сверка и поколение защищают даже метаданные незавершённого результата', async () => {
  const storage = await openStorage(':memory:');
  try {
    const scope = scopeFor(storage, group),
      neighbor = scopeFor(storage, 'vk:2000000042');
    const registry = participantRegistryStore(storage),
      budget = tokenBudgetStore(storage);
    const first = budget.beginObservation(scope, now);
    const second = budget.beginObservation(scope, now + 1);
    expect(budget.finishObservation(scope, second, full(boris), now + 2)).toBe(true);
    const then = registry.read(scope);
    expect(budget.finishObservation(scope, first, full(anna), now + 3)).toBe(false);
    expect(budget.finishObservation(scope, second, { complete: false }, now + 4)).toBe(false);
    expect(registry.read(scope)).toEqual(then);
    expect(registry.read(neighbor).participants).toEqual([]);
    const inProgress = budget.beginObservation(scope, now + 5);
    const life = lifecycleBackend(storage);
    const fresh = life.ownerDecision(life.begin(group), 'new');
    expect(() => budget.finishObservation(scope, inProgress, full(anna), now + 6)).toThrow(
      'stale_scope',
    );
    expect(budget.finishObservation(fresh, inProgress, full(anna), now + 6)).toBe(false);
    expect(registry.read(fresh)).toMatchObject({ participants: [], lastAttemptAt: null });
    expect(budget.read(fresh, true, now + 7).people).toBeNull();
  } finally {
    await storage.close();
  }
});

test('сбой обновления бюджета полностью откатывает запись людей и полноты', async () => {
  const files = storageFixture();
  const storage = await openStorage(files.path);
  const connection = await openConnection(files.path);
  try {
    const scope = scopeFor(storage, group);
    const registry = participantRegistryStore(storage),
      budget = tokenBudgetStore(storage);
    expect(
      budget.finishObservation(
        scope,
        budget.beginObservation(scope, now - 10),
        full(boris),
        now - 9,
      ),
    ).toBe(true);
    const run = budget.beginObservation(scope, now);
    const before = registry.read(scope);
    connection.run((db) =>
      db.exec(`CREATE TRIGGER stop_budget BEFORE UPDATE OF people ON chat_token_budgets
      BEGIN SELECT raise(ABORT,'test'); END`),
    );
    expect(() => budget.finishObservation(scope, run, full(anna, boris), now + 1)).toThrow(
      'operation_failed',
    );
    expect(registry.read(scope)).toEqual(before);
    expect(budget.read(scope, true, now + 1).people).toBe(1);
  } finally {
    connection.close();
    await storage.close();
    files.cleanup();
  }
});
