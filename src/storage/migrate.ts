import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { safeError, StorageError } from './errors.js';
import { migrations, type Migration } from './migrations/index.js';

interface AppliedMigration { version: number; name: string; checksum: string }
function checksum(migration: Migration): string {
  return createHash('sha256').update(migration.sql).digest('hex');
}
/** Внутренний механизм; набор можно менять только во внутренних тестах. */
export function migrate(database: Database, available: readonly Migration[] = migrations): void {
  try {
    if (!available.every((migration, index) => migration.version === index + 1)) {
      throw new StorageError('schema_incompatible');
    }
    database.transaction(() => {
      const objects = database.prepare("SELECT name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").all() as { name: string }[];
      const hasMetadata = objects.some(({ name }) => name === 'schema_migrations');
      if (!hasMetadata && objects.length > 0) throw new StorageError('schema_incompatible');
      database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL
      ) STRICT;`);
      let applied: AppliedMigration[];
      try {
        applied = database.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all() as AppliedMigration[];
      } catch { throw new StorageError('schema_incompatible'); }
      for (const [index, recorded] of applied.entries()) {
        const expected = available[index];
        if (!expected || recorded.version !== expected.version || recorded.name !== expected.name || recorded.checksum !== checksum(expected)) {
          throw new StorageError('schema_incompatible');
        }
      }
      const record = database.prepare('INSERT INTO schema_migrations(version, name, checksum) VALUES (?, ?, ?)');
      for (const migration of available.slice(applied.length)) {
        database.exec(migration.sql);
        record.run(migration.version, migration.name, checksum(migration));
      }
    }).immediate();
  } catch (error) { throw safeError(error, 'migration_failed'); }
}
