import type { Database } from 'better-sqlite3';
import { safeError, StorageError } from './errors';
import { databasePath } from './validation';

/** Внутренний доступ; наружу через index.ts не экспортируется. */
export interface Connection {
  run<T>(operation: (database: Database) => T): T;
  close(): void;
}
export async function openConnection(path: string, initialize?: (database: Database) => void): Promise<Connection> {
  databasePath(path);
  let database: Database | undefined;
  try {
    const { default: Driver } = await import('better-sqlite3');
    database = new Driver(path);
    database.pragma('foreign_keys = ON');
    if (database.pragma('foreign_keys', { simple: true }) !== 1) throw new StorageError('unavailable');
    initialize?.(database);
    const opened = database;
    return {
      run<T>(operation: (database: Database) => T): T {
        if (!opened.open) throw new StorageError('closed');
        try { return operation(opened); }
        catch (error) { throw safeError(error, 'operation_failed'); }
      },
      close() {
        if (opened.open) {
          try { opened.close(); }
          catch { throw new StorageError('operation_failed'); }
        }
      },
    };
  } catch (error) {
    if (database?.open) { try { database.close(); } catch { /* Сохраняем безопасную первичную ошибку. */ } }
    throw safeError(error, 'unavailable');
  }
}
