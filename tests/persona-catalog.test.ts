import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { defaultPersonaId, starterPersonas } from '../src/core/personas/catalog';
import { installStarterPersonas } from '../src/storage/catalog-admin';
import { openStorage } from '../src/storage/index';
import { migrate } from '../src/storage/migrate';
import { migrations } from '../src/storage/migrations/index';
import { scopeFor } from './helpers/connection-scope';
import { storageFixture } from './helpers/storage-fixture';

const checksums = {
  alex: 'c5bf61392b42ad27ca6427bd96f7fd7a9e523aa1cea8085ba70e260111c251c8',
  max: '04e8e2959e527a94bb31242d2987f51c57adc73c5ffca9d0a1ae16b5a1b34782',
  socrates: 'fc5e386d2f1097d45e63f37549f08e6e544683d26ad1fb8b750fac64fb15f355',
  victor: '2847772b871006935a348a8e4a8c185afb42821a6b3db2910acb9b8e1d2c298c',
  nikon: 'a582f226d9025b6190ecc8645683d6497f9a664b7402200cc6e62e6a266dd01b',
  chipsik: '84302dd6c96ce458a9a54f6d9ed2378286dcd5d1e63c6e2953f86fb050f4b9e6',
};

test('полный каталог совпадает с зафиксированным исходником bbc6b69', () => {
  expect(defaultPersonaId).toBe('max');
  expect(starterPersonas.map(({ id }) => id)).toEqual(Object.keys(checksums));
  expect(starterPersonas.map(({ name }) => name)).toEqual([
    'Алекс',
    'Макс',
    'Сократ',
    'Виктор',
    'Никон',
    'Чипсик',
  ]);
  for (const card of starterPersonas)
    expect(createHash('sha256').update(JSON.stringify(card)).digest('hex')).toBe(
      checksums[card.id as keyof typeof checksums],
    );
});

function installed(db: Database.Database) {
  return db
    .prepare(
      `SELECT s.persona_id AS id,s.entity_key AS key,s.version,v.text,v.created_at AS createdAt
       FROM starter_persona_versions s JOIN global_content_versions v USING(kind,entity_key,version)
       ORDER BY s.rowid`,
    )
    .all();
}

test('установка сохраняет точные версии, повторный запуск читает прежние привязки', async () => {
  const files = storageFixture();
  let storage = await openStorage(files.path);
  const db = new Database(files.path);
  try {
    const scope = scopeFor(storage, 'vk:42');
    await storage.chats.create(scope, { enabled: true, responseMode: 'normal', createdAt: 1 });
    expect(installed(db)).toEqual([]);
    installStarterPersonas(storage, 100);
    const rows = installed(db);
    expect(rows).toEqual(
      starterPersonas.map((card) => ({
        id: card.id,
        key: card.id,
        version: 1,
        text: JSON.stringify(card),
        createdAt: 100,
      })),
    );
    await storage.close();
    storage = await openStorage(files.path);
    installStarterPersonas(storage, 200);
    expect(installed(db)).toEqual(rows);
    expect(await storage.versions.selected(scopeFor(storage, scope.chatId), 'persona')).toBeNull();
    expect(db.prepare('SELECT * FROM chat_content_selections').all()).toEqual([]);
  } finally {
    db.close();
    await storage.close();
    files.cleanup();
  }
});

test('обновление сохраняет прежний общий и локальный выбор при занятых ключах', async () => {
  const files = storageFixture();
  const db = new Database(files.path);
  try {
    migrate(db, migrations.slice(0, 43));
    db.exec(`
      INSERT INTO chat_connections(chat_id,generation,revision,state) VALUES
        ('vk:11',1,0,'active'),('vk:12',2,0,'active');
      INSERT INTO global_content_versions VALUES
        ('persona','max',1,'Прошлый характер',10),
        ('persona','starter-max',1,'Занятый запасной ключ',11);
      INSERT INTO local_content_versions VALUES
        ('vk:12',2,'persona','old',1,'Прошлый локальный характер',12);
      INSERT INTO chat_content_selections VALUES
        ('vk:11',1,'persona','max',1,NULL,NULL),
        ('vk:12',2,'persona',NULL,NULL,'old',1);
    `);
    const storage = await openStorage(files.path);
    try {
      installStarterPersonas(storage, 100);
      expect(installed(db)).toHaveLength(6);
      expect(installed(db)).toContainEqual(
        expect.objectContaining({ id: 'max', key: 'starter-max-2', version: 1 }),
      );
      expect(await storage.versions.selected(scopeFor(storage, 'vk:11'), 'persona')).toMatchObject({
        ref: { area: 'global', key: 'max', version: 1 },
        text: 'Прошлый характер',
      });
      expect(await storage.versions.selected(scopeFor(storage, 'vk:12'), 'persona')).toMatchObject({
        ref: { area: 'local', key: 'old', version: 1 },
        text: 'Прошлый локальный характер',
      });
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      await storage.close();
    }
  } finally {
    db.close();
    files.cleanup();
  }
});

test('сбой посередине установки откатывает версии и привязки', async () => {
  const files = storageFixture();
  let storage = await openStorage(files.path, {
    versioning: { textMaxLength: 700, maxPerEntity: 1 },
  });
  const db = new Database(files.path);
  try {
    expect(() => installStarterPersonas(storage, 100)).toThrow('limit_exceeded');
    expect(installed(db)).toEqual([]);
    expect(db.prepare("SELECT * FROM global_content_versions WHERE kind='persona'").all()).toEqual(
      [],
    );
    await storage.close();
    storage = await openStorage(files.path);
    installStarterPersonas(storage, 200);
    expect(installed(db)).toHaveLength(6);
    expect(installed(db)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'alex', version: 1, createdAt: 200 })]),
    );
  } finally {
    db.close();
    await storage.close();
    files.cleanup();
  }
});
