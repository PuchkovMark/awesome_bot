import Database from 'better-sqlite3';
import { linkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  createSnapshot,
  openCandidate,
  openExisting,
  snapshotMetadata,
} from '../src/storage/database-backup';
import { migrate } from '../src/storage/migrate';
import { migrations } from '../src/storage/migrations/index';
import { storageFixture } from './helpers/storage-fixture';

const fixtures: ReturnType<typeof storageFixture>[] = [];
function files() {
  const f = storageFixture();
  fixtures.push(f);
  return {
    ...f,
    snapshot: join(f.directory, 'snapshot'),
    candidate: join(f.directory, 'candidate'),
  };
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});

test('согласованная копия двух чатов и миграция только проверочного экземпляра', async () => {
  const f = files();
  const writer = new Database(f.path);
  migrate(writer, migrations.slice(0, 1));
  writer.exec(
    "INSERT INTO chats VALUES ('vk:a',NULL,NULL,'mention','UTC',1,0),('vk:b',NULL,NULL,'always','UTC',1,0)",
  );
  const source = openExisting(f.path);
  try {
    const pending = createSnapshot(source, f.snapshot, 'installation', 123);
    writer.transaction(() => {
      writer.exec(
        "INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp) SELECT chat_id,'1','vk:u','','user',chat_id,1 FROM chats",
      );
    })();
    const stamp = await pending;
    await openCandidate(f.snapshot, f.candidate, 'installation', 125);
    const saved = openExisting(f.snapshot),
      restored = openExisting(f.candidate);
    try {
      expect(snapshotMetadata(saved)).toEqual(stamp);
      expect(saved.prepare('SELECT count(*) FROM schema_migrations').pluck().get()).toBe(1);
      expect(restored.prepare('SELECT count(*) FROM schema_migrations').pluck().get()).toBe(
        migrations.length,
      );
      expect(restored.prepare('SELECT chat_id FROM chats ORDER BY chat_id').pluck().all()).toEqual([
        'vk:a',
        'vk:b',
      ]);
      const rows = saved.prepare('SELECT chat_id,text FROM messages ORDER BY chat_id').all();
      expect([0, 2]).toContain(rows.length);
      expect(restored.prepare('SELECT chat_id,text FROM messages ORDER BY chat_id').all()).toEqual(
        rows,
      );
      expect(snapshotMetadata(source)).toBeUndefined();
    } finally {
      saved.close();
      restored.close();
    }
    await expect(openCandidate(f.snapshot, f.snapshot, 'installation', 125)).rejects.toThrow();
    await expect(openCandidate(f.snapshot, f.candidate, 'other', 125)).rejects.toThrow(
      'foreign_snapshot',
    );
  } finally {
    source.close();
    writer.close();
  }
});

test('не принимает пропавший, пустой, повреждённый или неизвестный источник и жёсткую ссылку', async () => {
  const f = files();
  expect(() => openExisting(f.path)).toThrow('database_missing');
  writeFileSync(f.path, '');
  expect(() => openExisting(f.path)).toThrow('database_empty');
  const db = new Database(f.path);
  migrate(db);
  db.exec("UPDATE schema_migrations SET checksum='bad' WHERE version=1");
  db.close();
  const source = openExisting(f.path);
  try {
    await expect(createSnapshot(source, f.snapshot, 'a', 10)).rejects.toThrow(
      'schema_incompatible',
    );
  } finally {
    source.close();
  }
  linkSync(f.path, f.candidate);
  expect(() => openExisting(f.candidate)).toThrow('unsafe_file');
  const bad = join(f.directory, 'corrupt');
  writeFileSync(bad, 'damaged');
  expect(() => {
    const corrupt = openExisting(bad);
    try {
      snapshotMetadata(corrupt);
    } finally {
      corrupt.close();
    }
  }).toThrow();
});
