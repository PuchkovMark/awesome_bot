import { expect, test, vi } from 'vitest';
import { personalDataStore } from '../src/storage/personal-data-store';
import { participantRegistryStore } from '../src/storage/participant-registry';
import { tokenBudgetStore } from '../src/storage/token-budget-store';
import { greetingStore } from '../src/storage/greeting-store';
import { migrate } from '../src/storage/migrate';
import { migrations } from '../src/storage/migrations/index';
import { profileFixture } from './helpers/profile-fact-fixture';
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

test('новые настройки действуют на последующие входы, с одним окном для двух публикаций', async () => {
  const f = await profileFixture();
  const start = Date.UTC(2026, 10, 23, 12);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  try {
    const target = await f.chat(chats[0], []);
    f.deliver(target);
    const registry = participantRegistryStore(f.storage);
    const joins = (user: `vk:${number}`, number: number, offset: number) => {
      clock.mockReturnValue(start + offset);
      expect(
        registry.observe(
          target,
          {
            kind: 'membership',
            chatId: target.chatId,
            actorId: user,
            subjectId: user,
            timestamp: start + offset,
            change: 'joined',
          },
          String(number),
          true,
        ),
      ).toBe(true);
    };
    const controls = (change: Parameters<typeof f.storage.authorization.transaction>[1]) =>
      f.storage.authorization.transaction(target, change);
    joins('vk:10', 10, 0);
    await controls((tx) => tx.writeInvitation(true, start, 20));
    joins('vk:11', 19, 0);
    joins('vk:12', 21, 0);
    await controls((tx) => tx.writeGreeting(true, start + 2_000, 22));
    joins('vk:13', 23, 29_000);
    joins('vk:14', 24, 30_000);

    const service = greetingStore(f.storage);
    const window = service.due(start + 30_000)!;
    expect(window.publication).toBe('greeting');
    expect(
      service.prepare(target, window.id, start + 30_000)?.members.map(({ user }) => user),
    ).toEqual(['vk:13']);
    expect(service.prepareInvitation(target, window.id, start + 30_000)).toBeNull();
    const sendId = service.allocate();
    expect(service.start(target, window.id, sendId, start + 30_000, 6, () => true)).toBe(true);
    expect(service.due(start + 30_000)).toBeNull();
    service.confirm(
      target,
      window.id,
      sendId,
      {
        messageId: '100',
        userId: 'vk:-314',
        authorName: 'Пенёк',
        timestamp: start + 30_000,
        text: 'Привет!',
      },
      ['vk:13'],
    );
    await f.reopen();
    const restored = scopeFor(f.storage, chats[0]);
    const reopened = greetingStore(f.storage);
    reopened.recover();
    expect(reopened.due(start + 30_000)?.publication).toBe('invitation');
    expect(
      reopened
        .prepareInvitation(restored, window.id, start + 30_000)
        ?.recipients.map(({ user }) => user),
    ).toEqual(['vk:12', 'vk:13']);

    await f.storage.authorization.transaction(restored, (tx) => {
      tx.writeGreeting(false, start + 30_000, 50);
      tx.writeGreeting(true, start + 30_000, 51);
    });
    expect(
      reopened
        .prepareInvitation(restored, window.id, start + 30_000)
        ?.recipients.map(({ user }) => user),
    ).toEqual(['vk:12']);
    const inviteId = reopened.allocate();
    expect(
      reopened.start(restored, window.id, inviteId, start + 30_000, 6, () => true, ['vk:12']),
    ).toBe(true);
    reopened.recover();
    expect(reopened.due(start + 30_000)).toBeNull();
    const next = reopened.due(start + 60_000)!;
    expect(next.id).not.toBe(window.id);
    expect(next.publication).toBe('invitation');
    expect(
      reopened
        .prepareInvitation(restored, next.id, start + 60_000)
        ?.recipients.map(({ user }) => user),
    ).toEqual([]);
  } finally {
    clock.mockRestore();
    await f.close();
  }
});

test('миграция 33 оставляет ожидающее приветствие и не добавляет приглашение задним числом', async () => {
  const files = storageFixture();
  try {
    const old = await openConnection(files.path, (db) => migrate(db, migrations.slice(0, 32)));
    try {
      old.run((db) => {
        db.exec(`INSERT INTO chat_connections(chat_id,generation,revision,state)
          VALUES ('vk:2000000045',1,0,'active');
          INSERT INTO greeting_windows(chat_id,generation,opened_at,due_at,state)
          VALUES ('vk:2000000045',1,100,30100,'waiting');
          INSERT INTO greeting_members VALUES(1,'vk:41',100,0);`);
      });
    } finally {
      old.close();
    }
    const migrated = await openConnection(files.path, migrate);
    try {
      migrated.run((db) => {
        expect(db.prepare('SELECT state,invitation_state FROM greeting_windows').get()).toEqual({
          state: 'waiting',
          invitation_state: 'skipped',
        });
        expect(
          db.prepare('SELECT user_id,greet,invitation,invited FROM greeting_members').get(),
        ).toEqual({ user_id: 'vk:41', greet: 1, invitation: 0, invited: 0 });
        expect(db.pragma('foreign_key_check')).toEqual([]);
      });
    } finally {
      migrated.close();
    }
  } finally {
    files.cleanup();
  }
});
