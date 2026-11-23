import { once } from 'node:events';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import type { ChatId, UserId } from '../src/contracts/index';
import { createLifecycleService } from '../src/core/index';
import { openConnection } from '../src/storage/connection';
import { openStorage } from '../src/storage/index';
import { migrate } from '../src/storage/migrate';
import { migrations } from '../src/storage/migrations/index';
import { scopeFor } from './helpers/connection-scope';
import { storageFixture } from './helpers/storage-fixture';

const first = 'vk:2000000001';
const second = 'vk:2000000002';
const owner = 'vk:73';
const ada = 'vk:111';
const bob = 'vk:222';
const select = (db: Database.Database, chatId: ChatId) =>
  db
    .prepare(
      'SELECT user_id AS userId,author_number AS authorNumber FROM chat_author_labels WHERE chat_id=? ORDER BY author_number',
    )
    .all(chatId);

function message(chatId: ChatId, userId: UserId, messageId: string, authorName = 'Саша Иванов') {
  return {
    chatId,
    userId,
    messageId,
    authorName,
    isGroupChat: true,
    role: 'user' as const,
    text: 'Синтетическая реплика',
    timestamp: Date.now(),
  };
}

test('миграция 22 заполняет 50 000 записей по первому доступному сообщению и сохраняет старую схему миграций', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys=ON');
    migrate(db, migrations.slice(0, 21));
    db.exec(`
      INSERT INTO chat_connections(chat_id,generation,revision,state)
      VALUES ('${first}',1,0,'active'),('${second}',2,0,'active'),('vk:44',3,0,'active'),
        ('test:group',4,0,'active');
      INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp)
      VALUES ('${first}','hidden','vk:90','','user','hidden',3),
        ('${first}','first','${ada}','','user','first',70),
        ('${first}','second','${bob}','','user','second',60),
        ('${first}','assistant','vk:-20','','assistant','bot',71),
        ('${second}','before','${bob}','','user','before',80),
        ('${second}','after','${ada}','','user','after',80),
        ('vk:44','direct','${ada}','','user','direct',80),
        ('test:group','group','test:author','','user','group',80);
      INSERT INTO history_retention_boundaries(chat_id,generation,cleared_through) VALUES ('${first}',1,1);
      INSERT INTO queue_jobs(chat_id,generation,message_id,received_at,expires_at,state,route_kind,route_mode,route_group)
      SELECT chat_id,4,id,1,2,'queued','mention','normal',1 FROM messages WHERE chat_id='test:group';
      WITH RECURSIVE many(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM many WHERE i<50000)
      INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp)
      SELECT '${first}', 'message-'||i, 'vk:'||(1000+i%500), '', 'user','история',90 FROM many;
    `);
    const checksums = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    migrate(db);
    expect(
      db.prepare('SELECT * FROM schema_migrations WHERE version<=21 ORDER BY version').all(),
    ).toEqual(checksums);
    const assigned = select(db, first);
    expect(assigned).toHaveLength(502);
    expect(assigned.slice(0, 4)).toEqual([
      { userId: ada, authorNumber: 1 },
      { userId: bob, authorNumber: 2 },
      { userId: 'vk:1001', authorNumber: 3 },
      { userId: 'vk:1002', authorNumber: 4 },
    ]);
    expect(select(db, second)).toEqual([
      { userId: bob, authorNumber: 1 },
      { userId: ada, authorNumber: 2 },
    ]);
    expect(select(db, 'test:group')).toEqual([{ userId: 'test:author', authorNumber: 1 }]);
    expect(select(db, 'vk:44')).toEqual([]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    migrate(db);
    expect(select(db, first)).toEqual(assigned);
  } finally {
    db.close();
  }
});

test('повтор, смена имени, удаление сообщений и перезапуск сохраняют номера, новое поколение начинает заново', async () => {
  const f = storageFixture();
  let storage = await openStorage(f.path);
  const read = await openConnection(f.path);
  try {
    const firstScope = scopeFor(storage, first);
    const secondScope = scopeFor(storage, second);
    await storage.messages.append(firstScope, message(first, ada, '1'));
    const duplicate = await storage.messages.append(firstScope, message(first, bob, '1'));
    expect(duplicate.status).toBe('duplicate');
    await storage.messages.append(secondScope, message(second, bob, '1'));
    await storage.messages.append(secondScope, message(second, ada, '2'));
    await storage.close();
    storage = await openStorage(f.path);

    read.run((db) => db.prepare('DELETE FROM messages WHERE chat_id=?').run(first));
    const scope = scopeFor(storage, first);
    expect(scope.generation).toBe(firstScope.generation);
    await storage.messages.append(scope, message(first, ada, '2', 'Александр Петров'));
    await storage.messages.append(scope, message(first, bob, '3'));
    expect(read.run((db) => select(db, first))).toEqual([
      { userId: ada, authorNumber: 1 },
      { userId: bob, authorNumber: 2 },
    ]);
    const life = createLifecycleService({
      storage,
      ownerId: owner,
      source: {
        async observe() {
          return { confidence: 'unavailable', bot: 'unknown' };
        },
      },
    });
    const fresh = life.decide(life.owner(first, owner), 'new');
    expect(fresh.generation).not.toBe(scope.generation);
    expect(read.run((db) => select(db, first))).toEqual([]);
    await storage.messages.append(fresh, message(first, bob, '1'));
    expect(read.run((db) => select(db, first))).toEqual([{ userId: bob, authorNumber: 1 }]);
    expect(read.run((db) => select(db, second))).toEqual([
      { userId: bob, authorNumber: 1 },
      { userId: ada, authorNumber: 2 },
    ]);
  } finally {
    read.close();
    await storage.close();
    f.cleanup();
  }
});

test('два соединения SQLite выделяют авторам разные номера при одновременной записи', async () => {
  const f = storageFixture();
  const storage = await openStorage(f.path);
  const readers: Worker[] = [];
  try {
    scopeFor(storage, first);
    const ready = ([ada, bob] as const).map((author, index) => {
      const worker = new Worker(
        `
        const { parentPort, workerData } = require('node:worker_threads');
        async function open() {
          const { openStorage } = await import(workerData.storageModule);
          const { createLifecycleService } = await import(workerData.lifecycleModule);
          const storage = await openStorage(workerData.path);
          const life = createLifecycleService({ storage, ownerId: 'vk:73', source: {} });
          parentPort.once('message', async () => {
            try {
              const result = await storage.messages.append(life.current(workerData.message.chatId), workerData.message);
              parentPort.postMessage(result.status);
            } finally {
              await storage.close();
            }
          });
          parentPort.postMessage('ready');
        }
        open().catch((error) => { throw error; });
      `,
        {
          eval: true,
          workerData: {
            path: f.path,
            message: message(first, author, String(index + 1)),
            storageModule: pathToFileURL(resolve('dist/storage/index.js')).href,
            lifecycleModule: pathToFileURL(resolve('dist/core/lifecycle/service.js')).href,
          },
        },
      );
      readers.push(worker);
      return once(worker, 'message');
    });
    await Promise.all(ready);
    const outcomes = readers.map((worker) => once(worker, 'message'));
    for (const worker of readers) worker.postMessage('go');
    expect(await Promise.all(outcomes)).toEqual([['inserted'], ['inserted']]);
    const inspection = await openConnection(f.path);
    try {
      const labels = inspection.run((db) => select(db, first)) as {
        userId: UserId;
        authorNumber: number;
      }[];
      expect(labels.map(({ authorNumber }) => authorNumber)).toEqual([1, 2]);
      expect(labels.map(({ userId }) => userId).sort()).toEqual([ada, bob]);
    } finally {
      inspection.close();
    }
  } finally {
    await Promise.all(readers.map((worker) => worker.terminate()));
    await storage.close();
    f.cleanup();
  }
});
