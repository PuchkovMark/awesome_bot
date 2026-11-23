import { expect, test } from 'vitest';
import { openStorage } from '../src/storage/index';
import { openConnection } from '../src/storage/connection';
import { createLifecycleService } from '../src/core/index';
import type { LifecycleObservation } from '../src/contracts/index';
import { storageFixture } from './helpers/storage-fixture';
import { participantFixture } from './helpers/participant-fixture';

const chatTables = [
  'messages',
  'chats',
  'chat_participants',
  'participant_profiles',
  'profile_facts',
  'bot_admin_grants',
  'bot_admin_revocations',
  'bot_admin_revocation_audit',
  'bot_admin_controls',
  'chat_connections',
] as const;
test('удаление всех сущностей и FTS, SQL-откат, изоляция и старое поколение после перезапуска', async () => {
  const f = storageFixture();
  let storage = await openStorage(f.path);
  let observation: LifecycleObservation = {
    confidence: 'confirmed',
    bot: 'present',
    creatorId: 'vk:a',
    inviterId: 'vk:a',
  };
  let life = createLifecycleService({
    storage,
    ownerId: 'vk:owner',
    source: {
      async observe() {
        return observation;
      },
    },
  });
  try {
    const scopes = [];
    for (const chatId of ['vk:one', 'vk:two'] as const) {
      const scope = (await life.verify(chatId)).scope!;
      scopes.push(scope);
      await storage.chats.create(scope, { responseMode: 'normal', enabled: true, createdAt: 0 });
      await storage.messages.append(scope, {
        chatId,
        userId: 'vk:a',
        messageId: '1',
        authorName: '',
        role: 'user',
        text: chatId === 'vk:one' ? 'удаляемыйкот' : 'сохранённыйкот',
        timestamp: 0,
      });
      await storage.messages.append(scope, {
        chatId,
        userId: 'vk:bot',
        messageId: '2',
        authorName: '',
        role: 'assistant',
        text: 'reply',
        timestamp: 1,
      });
      await storage.authorization.transaction(scope, (tx) => {
        tx.grant({ userId: 'vk:a', basis: 'explicit', grantedAt: 0, grantedBy: 'vk:owner' });
        tx.revoke({
          userId: 'vk:a',
          revokedBy: 'vk:owner',
          revokedAt: 1,
          bases: tx.bases('vk:a'),
          reason: 'private',
        });
      });
    }
    const inspect = await openConnection(f.path);
    try {
      const before = inspect.run((db) => {
        const pf = participantFixture(db);
        for (const chatId of ['vk:one', 'vk:two']) {
          pf.participant(chatId, 'vk:a');
          pf.profile(chatId, 'vk:a');
          pf.fact(chatId, 'vk:a');
        }
        return Object.fromEntries(
          chatTables.map((t) => [t, db.prepare(`SELECT * FROM ${t}`).all()]),
        );
      });
      const clockBefore = inspect.run((db) => db.prepare('SELECT * FROM lifecycle_clock').all());
      const schemaBefore = inspect.run((db) => db.prepare('SELECT * FROM schema_migrations').all());
      inspect.run((db) =>
        db.exec(
          "CREATE TRIGGER fail_cleanup BEFORE DELETE ON chats BEGIN SELECT RAISE(ABORT,'private'); END",
        ),
      );
      observation = { confidence: 'confirmed', bot: 'absent' };
      await expect(life.verify('vk:one')).rejects.toMatchObject({ code: 'operation_failed' });
      inspect.run((db) => {
        for (const t of chatTables)
          expect(db.prepare(`SELECT * FROM ${t}`).all()).toEqual(before[t]);
        expect(db.prepare('SELECT * FROM lifecycle_clock').all()).toEqual(clockBefore);
        expect(
          db
            .prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'удаляемыйкот'")
            .all(),
        ).toHaveLength(1);
        db.exec('DROP TRIGGER fail_cleanup');
      });
      expect((await life.verify('vk:one')).status).toBe('applied');
      inspect.run((db) => {
        for (const t of chatTables) {
          expect(db.prepare(`SELECT * FROM ${t} WHERE chat_id='vk:one'`).all()).toEqual([]);
          expect(db.prepare(`SELECT * FROM ${t} WHERE chat_id='vk:two'`).all()).toEqual(
            (before[t] as { chat_id: string }[]).filter((r) => r.chat_id === 'vk:two'),
          );
        }
        expect(
          db
            .prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'удаляемыйкот'")
            .all(),
        ).toEqual([]);
        expect(
          db
            .prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'сохранённыйкот'")
            .all(),
        ).toHaveLength(1);
        expect(db.prepare('SELECT * FROM schema_migrations').all()).toEqual(schemaBefore);
        expect(db.pragma('foreign_key_check')).toEqual([]);
      });
      expect((await life.verify('vk:one')).status).toBe('applied');
      observation = { confidence: 'confirmed', bot: 'present' };
      const next = (await life.verify('vk:one')).scope!;
      expect(next.generation).not.toBe(scopes[0]!.generation);
      await expect(storage.chats.get(scopes[0]!)).rejects.toMatchObject({ code: 'stale_scope' });
      await expect(
        storage.messages.append(scopes[0]!, {
          chatId: 'vk:one',
          userId: 'vk:a',
          messageId: 'late',
          authorName: '',
          role: 'user',
          text: 'late',
          timestamp: 2,
        }),
      ).rejects.toMatchObject({ code: 'stale_scope' });
      expect(
        await storage.authorization.transaction(next, (tx) => ({
          revoked: tx.isRevoked('vk:a'),
          blocked: tx.recoveryBlocked(),
          audit: tx.audit('vk:a'),
          bases: tx.bases('vk:a'),
        })),
      ).toEqual({ revoked: false, blocked: false, audit: null, bases: [] });
      await storage.close();
      storage = await openStorage(f.path);
      life = createLifecycleService({
        storage,
        ownerId: 'vk:owner',
        source: {
          async observe() {
            return observation;
          },
        },
      });
      expect(life.current('vk:one').generation).toBe(next.generation);
      await expect(storage.chats.get(next)).rejects.toMatchObject({ code: 'invalid_input' });
    } finally {
      inspect.close();
    }
  } finally {
    await storage.close();
    f.cleanup();
  }
});

test('старое подтверждение отсутствия и старое решение владельца не переживают цикл подключения', async () => {
  const storage = await openStorage(':memory:');
  let resolve!: (v: LifecycleObservation) => void;
  const delayed = createLifecycleService({
    storage,
    ownerId: 'vk:owner',
    source: {
      observe() {
        return new Promise((r) => {
          resolve = r;
        });
      },
    },
  });
  let observation: LifecycleObservation = { confidence: 'confirmed', bot: 'present' };
  const fresh = createLifecycleService({
    storage,
    ownerId: 'vk:owner',
    source: {
      async observe() {
        return observation;
      },
    },
  });
  try {
    const pending = delayed.verify('vk:1');
    const oldOwner = fresh.owner('vk:1', 'vk:owner');
    await fresh.verify('vk:1');
    observation = { confidence: 'confirmed', bot: 'absent' };
    await fresh.verify('vk:1');
    resolve({ confidence: 'confirmed', bot: 'present' });
    expect((await pending).status).toBe('stale');
    expect(() => fresh.decide(oldOwner, 'new')).toThrow('stale_scope');
    expect(() => fresh.current('vk:1')).toThrow('stale_scope');
  } finally {
    await storage.close();
  }
});

test('решение владельца new сбрасывает uncertain; поздний ответ и старый owner не изменяют новое', async () => {
  const storage = await openStorage(':memory:');
  let observation: LifecycleObservation = { confidence: 'confirmed', bot: 'present' };
  const life = createLifecycleService({
    storage,
    ownerId: 'vk:owner',
    source: {
      async observe() {
        return observation;
      },
    },
  });
  try {
    const first = (await life.verify('vk:1')).scope!;
    await storage.chats.create(first, { responseMode: 'normal', enabled: true, createdAt: 0 });
    const old = life.owner('vk:1', 'vk:owner');
    observation = { confidence: 'uncertain', bot: 'unknown' };
    await life.verify('vk:1');
    observation = { confidence: 'confirmed', bot: 'absent' };
    expect((await life.verify('vk:1')).status).toBe('uncertain');
    const next = life.decide(life.owner('vk:1', 'vk:owner'), 'new');
    expect(next.generation).not.toBe(first.generation);
    expect(await storage.chats.get(next)).toBeNull();
    expect(() => life.decide(old, 'continue')).toThrow('stale_scope');
  } finally {
    await storage.close();
  }
});
