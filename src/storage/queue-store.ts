import type { Database } from 'better-sqlite3';
import type { ConnectionScope } from '../contracts/index.js';
import type { Connection } from './connection.js';
import type { LifecycleBackend } from './lifecycle-store.js';
import type { QueueRecord } from './queue-types.js';
import { StorageError } from './errors.js';
import { requireInput, timestamp } from './validation.js';
export function createQueueBackend(connection: Connection, lifecycle: LifecycleBackend) {
  function owned(db: Database, token: string) {
    const row = db.prepare('SELECT token,expires_at AS expires FROM queue_lease WHERE singleton=1').get() as {token:string|null;expires:number};
    if (row.token !== token || row.expires <= Date.now()) throw new StorageError('queue_lost_ownership');
  }
  function transaction<T>(token: string, operation: (db: Database) => T): T {
    return connection.run(db => db.transaction(() => { owned(db, token); const result = operation(db); owned(db, token); return result; }).immediate());
  }
  return {
    transaction,
    acquire(token: string, leaseMs: number, safetyMs: number) {
      requireInput(typeof token === 'string' && token.length > 0); timestamp(leaseMs); timestamp(safetyMs);
      return connection.run(db => db.transaction(() => {
        const now = Date.now(); timestamp(now + leaseMs);
        const row = db.prepare('SELECT token,expires_at AS expires FROM queue_lease WHERE singleton=1').get() as {token:string|null;expires:number};
        if (row.token !== null && row.expires > now) throw new StorageError('queue_owned');
        db.prepare('UPDATE queue_lease SET token=?,expires_at=?,safety_ms=? WHERE singleton=1').run(token, now + leaseMs, safetyMs);
        const recovered = db.prepare("UPDATE queue_jobs SET state='terminal',outcome='interrupted',owner=NULL WHERE state='running'").run().changes;
        return recovered;
      }).immediate());
    },
    renew(token: string, leaseMs: number) {
      return transaction(token, db => { const expires = Date.now() + leaseMs; timestamp(expires); db.prepare('UPDATE queue_lease SET expires_at=? WHERE singleton=1').run(expires); });
    },
    release(token: string) { return connection.run(db => db.transaction(() => { owned(db, token); db.prepare('UPDATE queue_lease SET token=NULL,expires_at=0,safety_ms=0 WHERE singleton=1').run(); }).immediate()); },
    check(token: string) { connection.run(db => owned(db, token)); },
    get(scope: ConnectionScope, id: number): QueueRecord | null {
      requireInput(Number.isSafeInteger(id) && id > 0);
      return lifecycle.transaction(scope, db => db.prepare(`SELECT id,message_id AS messageId,received_at AS receivedAt,expires_at AS expiresAt,state,outcome
        FROM queue_jobs WHERE chat_id=? AND generation=? AND id=?`).get(scope.chatId, scope.generation, id) as QueueRecord | undefined ?? null);
    },
  };
}
export type QueueBackend = ReturnType<typeof createQueueBackend>;
