import { expect, test, vi } from 'vitest';
import { personalDataStore } from '../src/storage/personal-data-store';
import { participantRegistryStore } from '../src/storage/participant-registry';
import { tokenBudgetStore } from '../src/storage/token-budget-store';
import { openConnection } from '../src/storage/connection';
import { lifecycleBackend } from '../src/storage/lifecycle-store';
import { scopeFor, openStorage } from './helpers/connection-scope';
import { storageFixture } from './helpers/storage-fixture';

const chats = ['vk:2000000045', 'vk:2000000046'] as const;

test('окна по границе 30 секунд, приглашение через актуальный снимок и повтор после рестарта', async () => {
  const file = storageFixture();
  let storage = await openStorage(file.path);
  const db = await openConnection(file.path);
  const utc = vi.spyOn(Date, 'now');
  const start = Date.UTC(2026, 10, 23, 12);
  utc.mockReturnValue(start);
  try {
    let scope = scopeFor(storage, chats[0]);
    const other = scopeFor(storage, chats[1]);
    for (const chat of [scope, other]) {
      await storage.chats.create(chat, { enabled: true, responseMode: 'normal', createdAt: start });
      await storage.authorization.transaction(chat, (tx) => tx.writeGreeting(true, start));
    }
    const registry = participantRegistryStore(storage);
    const observe = (
      user: `vk:${number}`,
      number: string,
      offset: number,
      change: 'joined' | 'invited' | 'left' = 'joined',
      target = scope,
    ) => {
      utc.mockReturnValue(start + offset);
      return registry.observe(
        target,
        {
          kind: 'membership',
          chatId: target.chatId,
          subjectId: user,
          actorId: user,
          timestamp: start + offset,
          change,
        },
        number,
        true,
      );
    };
    expect(observe('vk:10', '1', 0)).toBe(true);
    expect(observe('vk:11', '2', 29_000)).toBe(true);
    expect(observe('vk:12', '3', 30_000)).toBe(true);
    expect(observe('vk:10', '1', 30_000, 'joined', other)).toBe(true);
    expect(observe('vk:13', '4', 30_001, 'invited')).toBe(true);
    const budget = tokenBudgetStore(storage);
    const first = budget.beginObservation(scope, start + 30_002);
    expect(budget.finishObservation(scope, first, { complete: false }, start + 30_003)).toBe(false);
    const read = () =>
      db.run((d) =>
        d
          .prepare(
            `SELECT w.chat_id AS chat,w.opened_at-? AS at,g.user_id AS user
      FROM greeting_windows w JOIN greeting_members g ON g.window_id=w.id ORDER BY w.id,g.user_id`,
          )
          .all(start),
      );
    expect(read()).toEqual([
      { chat: chats[0], at: 0, user: 'vk:10' },
      { chat: chats[0], at: 0, user: 'vk:11' },
      { chat: chats[0], at: 30_000, user: 'vk:12' },
      { chat: chats[1], at: 30_000, user: 'vk:10' },
    ]);
    const latest = budget.beginObservation(scope, start + 30_004);
    const members = [10, 11, 12, 13, 14].map((id) => ({
      userId: `vk:${id}` as const,
      role: 'member' as const,
    }));
    expect(
      budget.finishObservation(
        scope,
        latest,
        { complete: true, people: members.length, members },
        start + 30_005,
      ),
    ).toBe(true);
    expect(read()).toContainEqual({ chat: chats[0], at: 30_000, user: 'vk:13' });
    expect(read()).not.toContainEqual(expect.objectContaining({ user: 'vk:14' }));
    expect(observe('vk:10', '5', 31_000, 'left')).toBe(true);
    expect(observe('vk:10', '6', 31_001)).toBe(true);
    expect(read()).not.toContainEqual({ chat: chats[0], at: 0, user: 'vk:10' });
    expect(read()).toContainEqual({ chat: chats[0], at: 30_000, user: 'vk:10' });
    const accepted = read();
    await storage.close();
    storage = await openStorage(file.path);
    scope = scopeFor(storage, chats[0]);
    const reopened = participantRegistryStore(storage);
    expect(
      reopened.observe(
        scope,
        {
          kind: 'membership',
          chatId: scope.chatId,
          subjectId: 'vk:10',
          actorId: 'vk:10',
          timestamp: start + 31_001,
          change: 'joined',
        },
        '6',
        true,
      ),
    ).toBe(false);
    expect(read()).toEqual(accepted);
    const lifecycle = lifecycleBackend(storage);
    lifecycle.apply(lifecycle.begin(chats[0]), { confidence: 'confirmed', bot: 'absent' });
    const replacement = scopeFor(storage, chats[0]);
    expect(
      await storage.authorization.transaction(
        replacement,
        (tx) => tx.controlState().greetingEnabledAt,
      ),
    ).toBeNull();
    expect(read()).toEqual([{ chat: chats[1], at: 30_000, user: 'vk:10' }]);
  } finally {
    utc.mockRestore();
    db.close();
    await storage.close();
    file.cleanup();
  }
});

test('в одной секунде поздний старый сигнал не проходит границу команды включения', async () => {
  const storage = await openStorage(':memory:');
  const now = Date.UTC(2026, 10, 23, 12);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  try {
    const scope = scopeFor(storage, chats[0]);
    await storage.chats.create(scope, { enabled: true, responseMode: 'normal', createdAt: now });
    await storage.authorization.transaction(scope, (tx) => tx.writeGreeting(true, now, 100));
    const registry = participantRegistryStore(storage);
    for (const [sequence, user] of [
      ['99', 'vk:21'],
      ['101', 'vk:22'],
    ] as const)
      registry.observe(
        scope,
        {
          kind: 'membership',
          chatId: scope.chatId,
          actorId: user,
          subjectId: user,
          timestamp: now,
          change: 'joined',
        },
        sequence,
        true,
      );
    const privacy = personalDataStore(storage);
    expect(privacy.export(scope, 'vk:21', now).serviceRecords.greetingEntries).toEqual([]);
    expect(privacy.export(scope, 'vk:22', now).serviceRecords.greetingEntries).toHaveLength(1);
  } finally {
    clock.mockRestore();
    await storage.close();
  }
});
