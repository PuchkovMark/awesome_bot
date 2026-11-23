import type { Database } from 'better-sqlite3';
import { StorageError } from './errors';
/** Вызывать внутри транзакции. Ни идентификаторов, ни журнала соответствий. */
export function advanceClock(db: Database): number {
  const row = db
    .prepare(
      'UPDATE lifecycle_clock SET value=value+1 WHERE singleton=1 AND value<9007199254740991 RETURNING value',
    )
    .get() as { value: number } | undefined;
  if (!row) throw new StorageError('operation_failed');
  return row.value;
}
