import { expect, test, vi } from 'vitest';
import { openConnection } from '../src/storage/connection';
import { storageFixture } from './helpers/storage-fixture';

test('FK включены до callback на каждом новом соединении, включая повторное открытие', async () => {
  const fixture = storageFixture();
  try {
    for (const path of [':memory:', ':memory:', fixture.path, fixture.path]) {
      const callback = vi.fn((db: import('better-sqlite3').Database) => {
        expect(db.inTransaction).toBe(false);
        expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      });
      const connection = await openConnection(path, callback);
      try {
        expect(callback).toHaveBeenCalledOnce();
        expect(connection.run((db) => db.pragma('foreign_keys', { simple: true }))).toBe(1);
      } finally {
        connection.close();
      }
    }
  } finally {
    fixture.cleanup();
  }
});
test('отказ включения FK закрывает соединение до инициализации и даёт безопасную ошибку', async () => {
  const references: { open: boolean }[] = [];
  class RefusingDatabase {
    open = true;
    constructor() {
      references.push(this);
    }
    pragma() {
      return 0;
    }
    close() {
      this.open = false;
    }
  }
  const initialize = vi.fn();
  vi.doMock('better-sqlite3', () => ({ default: RefusingDatabase }));
  try {
    const error: unknown = await openConnection(fixturePath(), initialize).catch(
      (error: unknown) => error,
    );
    expect(error).toMatchObject({ code: 'unavailable', message: 'Storage: unavailable' });
    expect(error).not.toHaveProperty('cause');
    expect(initialize).not.toHaveBeenCalled();
    expect(references).toHaveLength(1);
    expect(references[0]?.open).toBe(false);
  } finally {
    vi.doUnmock('better-sqlite3');
  }
});
function fixturePath(): string {
  return '/not-opened/SECRET.sqlite';
}
