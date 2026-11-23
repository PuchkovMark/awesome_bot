import { openStorage, scopeFor } from './helpers/connection-scope';
import { expect, test } from 'vitest';

import { openConnection } from '../src/storage/connection';
import { migrate } from '../src/storage/migrate';
import { migrations } from '../src/storage/migrations/index';
import { storageFixture } from './helpers/storage-fixture';
import { participantFixture } from './helpers/participant-fixture';
import { participantRegistryStore } from '../src/storage/participant-registry';
import { lifecycleBackend } from '../src/storage/lifecycle-store';

const oldMessage = {
  chatId: 'a:old',
  userId: 'a:u',
  messageId: 'one',
  authorName: 'Имя',
  role: 'user',
  text: 'старыйкот',
  timestamp: 0,
} as const;
test('F1.4 → версия 3 сохраняет историю, настройки, FTS, новые данные и прежние миграции', async () => {
  const fixture = storageFixture();
  const seed = await openConnection(fixture.path, (db) => migrate(db, migrations.slice(0, 2)));
  let previous: unknown[];
  try {
    previous = seed.run((db) => {
      db.exec(
        "INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp) VALUES ('a:old','one','a:u','Имя','user','старыйкот',0)",
      );
      db.exec(
        "INSERT INTO chats(chat_id,title,system_prompt,response_mode,timezone,enabled,created_at) VALUES ('a:old','Изменённое название','Сохранённый промпт','always','UTC',1,0)",
      );
      return db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    });
  } finally {
    seed.close();
  }
  try {
    const storage = await openStorage(fixture.path);
    try {
      expect(
        await storage.messages.list(scopeFor(storage, oldMessage.chatId), { limit: 10 }),
      ).toMatchObject([oldMessage]);
      expect(await storage.chats.get(scopeFor(storage, oldMessage.chatId))).toMatchObject({
        title: 'Изменённое название',
        responseMode: 'normal',
        timezone: 'UTC',
        enabled: true,
        createdAt: 0,
      });
      expect(
        await storage.messages.append(
          scopeFor(storage, { ...oldMessage, text: 'неподменять' }.chatId),
          { ...oldMessage, text: 'неподменять' },
        ),
      ).toMatchObject({ status: 'duplicate' });
      await storage.messages.append(
        scopeFor(storage, { ...oldMessage, chatId: 'a:before-settings', messageId: 'new' }.chatId),
        { ...oldMessage, chatId: 'a:before-settings', messageId: 'new' },
      );
      expect(await storage.chats.get(scopeFor(storage, 'a:before-settings'))).toBeNull();
      const inspection = await openConnection(fixture.path);
      try {
        inspection.run((db) => {
          expect(
            db.prepare('SELECT * FROM schema_migrations WHERE version <= 2 ORDER BY version').all(),
          ).toEqual(previous);
          expect(
            db.prepare('SELECT version FROM schema_migrations ORDER BY version').all(),
          ).toEqual([
            { version: 1 },
            { version: 2 },
            { version: 3 },
            { version: 4 },
            { version: 5 },
            { version: 6 },
            { version: 7 },
            { version: 8 },
            { version: 9 },
            { version: 10 },
            { version: 11 },
            { version: 12 },
            { version: 13 },
            { version: 14 },
            { version: 15 },
            { version: 16 },
            { version: 17 },
            { version: 18 },
            { version: 19 },
            { version: 20 },
            { version: 21 },
            { version: 22 },
            { version: 23 },
            { version: 24 },
            { version: 25 },
            { version: 26 },
            { version: 27 },
            { version: 28 },
            { version: 29 },
            { version: 30 },
            { version: 31 },
            { version: 32 },
            { version: 33 },
            { version: 34 },
            { version: 35 },
            { version: 36 },
            { version: 37 },
            { version: 38 },
            { version: 39 },
            { version: 40 },
            { version: 41 },
            { version: 42 },
            { version: 43 },
          ]);
          expect(db.prepare('SELECT * FROM chat_participants').all()).toEqual([]);
          expect(db.prepare('SELECT * FROM participant_profiles').all()).toEqual([]);
          expect(db.prepare('SELECT * FROM profile_facts').all()).toEqual([]);
          expect(
            db
              .prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?')
              .all('старыйкот'),
          ).toHaveLength(2);
          expect(
            db
              .prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?')
              .all('неподменять'),
          ).toEqual([]);
          const f = participantFixture(db);
          f.participant('a:old', 'a:u');
          f.profile('a:old', 'a:u');
          f.fact('a:old', 'a:u', {
            sourceKind: 'self',
            sourceUserId: 'a:u',
            visibility: 'bot',
            reliability: 'unverified',
            value: 'Сохранённый 🐈',
          });
          expect(db.pragma('foreign_key_check')).toEqual([]);
        });
      } finally {
        inspection.close();
      }
    } finally {
      await storage.close();
    }
    const reopened = await openStorage(fixture.path);
    try {
      const inspection = await openConnection(fixture.path);
      try {
        inspection.run((db) => {
          const f = participantFixture(db);
          expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
          expect(f.participants('a:old', 'a:u')).toMatchObject([
            { joined_at: null, role: 'unknown', status: 'unknown', last_seen_at: null },
          ]);
          expect(f.profiles('a:old', 'a:u')).toMatchObject([{ created_at: 0, updated_at: 0 }]);
          expect(f.facts('a:old', 'a:u')).toMatchObject([
            { value: 'Сохранённый 🐈', visibility: 'bot', reliability: 'unverified' },
          ]);
          expect(
            db.prepare('SELECT * FROM schema_migrations WHERE version <= 2 ORDER BY version').all(),
          ).toEqual(previous);
          expect(db.prepare('SELECT count(*) AS n FROM schema_migrations').get()).toEqual({
            n: migrations.length,
          });
          expect(db.pragma('foreign_key_check')).toEqual([]);
        });
      } finally {
        inspection.close();
      }
      expect(
        await reopened.messages.append(scopeFor(reopened, oldMessage.chatId), oldMessage),
      ).toMatchObject({ status: 'duplicate' });
    } finally {
      await reopened.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test('миграция реестра сохраняет заполненные профили, ссылки, счётчик фактов и область очистки', async () => {
  const fixture = storageFixture();
  const seed = await openConnection(fixture.path, (db) => migrate(db, migrations.slice(0, 25)));
  let deleted = 0;
  try {
    seed.run((db) => {
      const f = participantFixture(db);
      for (const [generation, chat] of ['vk:2000000001', 'vk:2000000002'].entries()) {
        f.chat(chat);
        db.prepare(
          "INSERT INTO chat_connections(chat_id,generation,revision,state) VALUES (?,?,0,'active')",
        ).run(chat, generation + 1);
        f.participant(chat, 'vk:42', {
          role: 'admin',
          status: 'present',
          joinedAt: 10,
          lastSeenAt: 30,
        });
        f.profile(chat, 'vk:42', { createdAt: 12, updatedAt: 18 });
        f.fact(chat, 'vk:42', { value: 'Сохранённый', sourceMessageId: '1' });
      }
      const last = f.fact('vk:2000000001', 'vk:42', { value: 'Удалённый' });
      deleted = Number(last.lastInsertRowid);
      db.prepare('DELETE FROM profile_facts WHERE id=?').run(deleted);
      db.exec('UPDATE lifecycle_clock SET value=2 WHERE singleton=1');
    });
  } finally {
    seed.close();
  }
  try {
    for (let phase = 0; phase < 2; phase++) {
      const storage = await openStorage(fixture.path);
      const inspection = await openConnection(fixture.path);
      try {
        const registry = participantRegistryStore(storage);
        const first = scopeFor(storage, 'vk:2000000001');
        const second = scopeFor(storage, 'vk:2000000002');
        expect(registry.read(second).participants).toEqual([
          expect.objectContaining({
            userId: 'vk:42',
            role: 'admin',
            status: 'present',
            joinedAt: 10,
            lastSeenAt: 30,
          }),
        ]);
        inspection.run((db) => {
          const f = participantFixture(db);
          expect(f.profiles(second.chatId, 'vk:42')).toMatchObject([
            { created_at: 12, updated_at: 18 },
          ]);
          expect(f.facts(second.chatId, 'vk:42')).toMatchObject([
            { value: 'Сохранённый', source_message_id: '1' },
          ]);
          expect(db.pragma('foreign_key_check')).toEqual([]);
          if (phase === 1) return;
          expect(Number(f.fact(first.chatId, 'vk:42').lastInsertRowid)).toBeGreaterThan(deleted);
          db.prepare('INSERT INTO participant_sync(chat_id,generation,revision) VALUES(?,?,1)').run(
            first.chatId,
            first.generation,
          );
          db.prepare('INSERT INTO participant_events VALUES(?,?,?)').run(
            first.chatId,
            first.generation,
            'vk:test',
          );
        });
        if (phase === 0) {
          const life = lifecycleBackend(storage);
          life.ownerDelete(life.begin(first.chatId), first.generation);
        } else {
          expect(registry.read(first).participants).toEqual([]);
          expect(
            inspection.run((db) => db.prepare('SELECT * FROM participant_sync').all()),
          ).toEqual([]);
          expect(
            inspection.run((db) => db.prepare('SELECT * FROM participant_events').all()),
          ).toEqual([]);
        }
      } finally {
        inspection.close();
        await storage.close();
      }
    }
  } finally {
    fixture.cleanup();
  }
});

test('миграция событий профиля не достраивает происхождение старого факта', async () => {
  const files = storageFixture();
  try {
    const old = await openConnection(files.path, (db) => migrate(db, migrations.slice(0, 28)));
    const recorded = old.run((db) => {
      const f = participantFixture(db);
      f.chat('vk:2000000001');
      f.participant('vk:2000000001', 'vk:41');
      f.profile('vk:2000000001', 'vk:41');
      f.fact('vk:2000000001', 'vk:41', {
        value: 'Сохранённое значение',
        sourceKind: 'admin',
        sourceUserId: null,
        sourceMessageId: null,
        visibility: 'unknown',
        reliability: 'unverified',
      });
      return db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    });
    old.close();
    for (let opening = 0; opening < 2; opening++) {
      const upgraded = await openConnection(files.path, migrate);
      try {
        upgraded.run((db) => {
          expect(db.prepare('SELECT * FROM profile_facts').all()).toMatchObject([
            {
              value: 'Сохранённое значение',
              source_kind: 'admin',
              source_user_id: null,
              source_message_id: null,
              visibility: 'unknown',
              reliability: 'unverified',
              generation: null,
              source_at: null,
              event_key: null,
              interest_key: '',
              change_kind: 'set',
            },
          ]);
          expect(
            db.prepare('SELECT * FROM schema_migrations WHERE version<=28 ORDER BY version').all(),
          ).toEqual(recorded);
          expect(db.pragma('foreign_key_check')).toEqual([]);
        });
      } finally {
        upgraded.close();
      }
    }
  } finally {
    files.cleanup();
  }
});
