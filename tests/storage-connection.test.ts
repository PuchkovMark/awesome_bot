import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openConnection } from '../src/storage/connection.js';
import { storageFixture } from './helpers/storage-fixture.js';

for (const memory of [true, false]) {
  test(`реальный драйвер и FTS5: memory=${memory}`, async () => {
    const fixture = storageFixture();
    const connection = await openConnection(memory ? ':memory:' : fixture.path);
    try {
      connection.run((db) => {
        db.exec("CREATE VIRTUAL TABLE smoke USING fts5(text); INSERT INTO smoke(text) VALUES ('кот');");
        expect(db.prepare('SELECT text FROM smoke WHERE smoke MATCH ?').get('кот')).toEqual({ text: 'кот' });
      });
      if (!memory) expect(existsSync(fixture.path)).toBe(true);
      connection.close();
      connection.close();
      expect(() => connection.run(() => 1)).toThrow('closed');
    } finally { connection.close(); fixture.cleanup(); }
  });
}
test('ошибки открытия не раскрывают путь и не создают родительский каталог', async () => {
  const fixture = storageFixture();
  try {
    const path = join(fixture.directory, 'SECRET-PATH', 'db.sqlite');
    const error: unknown = await openConnection(path).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'unavailable', message: 'Storage: unavailable' });
    expect(error).not.toHaveProperty('cause');
    expect(String(error)).not.toContain('SECRET-PATH');
    expect(existsSync(join(fixture.directory, 'SECRET-PATH'))).toBe(false);
  } finally { fixture.cleanup(); }
});
test('ошибка инициализации закрывает соединение и скрывает SQL', async () => {
  let reference: import('better-sqlite3').Database | undefined;
  await expect(openConnection(':memory:', (db) => {
    reference = db;
    db.exec('SECRET SQL');
  })).rejects.toMatchObject({ code: 'unavailable' });
  expect(reference?.open).toBe(false);
});
