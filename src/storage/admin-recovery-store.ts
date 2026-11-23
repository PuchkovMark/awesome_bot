import { randomInt } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { ChatId, ConnectionScope, UserId } from '../contracts/index';
import type { Connection } from './connection';
import type { LifecycleBackend } from './lifecycle-store';
import type { Storage } from './types';
import { compositeId, requireInput, timestamp } from './validation';

export type RecoveryReason = 'unavailable' | 'unconfirmed' | 'interrupted';
export interface RecoveryOperation {
  readonly id: number;
  readonly chatId: ChatId;
  readonly generation: number;
  readonly userId: UserId;
  readonly ownerId: UserId;
  readonly result: 'granted' | 'existing';
  readonly state: 'pending_delivery' | 'sending' | 'delivered';
  readonly reason: RecoveryReason | null;
  readonly createdAt: number;
  readonly sendId: number;
  readonly attempt: number;
  readonly attemptedAt: number | null;
  readonly receipt: string | null;
}

export interface RecoveryCommand {
  readonly ownerId: UserId;
  readonly commandId: number;
  readonly userId: UserId;
}

export type AdministrationStatus = {
  readonly chatId: ChatId;
  readonly generation: number;
  readonly state: 'available' | 'missing' | 'unknown';
};

const columns = `id,chat_id AS chatId,generation,user_id AS userId,owner_id AS ownerId,result,state,reason,
  created_at AS createdAt,send_id AS sendId,attempt,attempted_at AS attemptedAt,receipt`;

export function findRecoveryCommand(
  db: Database,
  ownerId: UserId,
  commandId: number,
): RecoveryOperation | undefined {
  compositeId(ownerId);
  requireInput(Number.isSafeInteger(commandId) && commandId > 0);
  return db
    .prepare(`SELECT ${columns} FROM admin_recovery_operations WHERE owner_id=? AND command_id=?`)
    .get(ownerId, commandId) as RecoveryOperation | undefined;
}

export function setAdminPresence(
  db: Database,
  scope: Pick<ConnectionScope, 'chatId' | 'generation'>,
  userId: UserId,
  present: boolean,
  eventId?: number,
): boolean {
  return (
    db
      .prepare(
        `INSERT INTO admin_presence(chat_id,generation,user_id,present,event_id) VALUES (?,?,?,?,?)
    ON CONFLICT(chat_id,generation,user_id) DO UPDATE SET present=excluded.present,event_id=coalesce(excluded.event_id,event_id)
    WHERE excluded.event_id IS NOT NULL OR present<>excluded.present`,
      )
      .run(scope.chatId, scope.generation, userId, Number(present), eventId ?? null).changes === 1
  );
}

export function recordRecoveryCommand(
  db: Database,
  chatId: ChatId,
  input: RecoveryCommand,
  result: RecoveryOperation['result'],
  now: number,
): RecoveryOperation {
  timestamp(now);
  const scope = db
    .prepare(
      "SELECT chat_id AS chatId,generation FROM chat_connections WHERE chat_id=? AND state='active'",
    )
    .get(chatId) as Pick<ConnectionScope, 'chatId' | 'generation'> | undefined;
  requireInput(scope);
  let sendId: number;
  do {
    sendId = randomInt(1, 0x80000000);
  } while (db.prepare('SELECT 1 FROM admin_recovery_operations WHERE send_id=?').get(sendId));
  db.prepare(
    `INSERT INTO admin_recovery_operations (chat_id,generation,user_id,owner_id,command_id,result,created_at,send_id)
    VALUES (?,?,?,?,?,?,?,?)`,
  ).run(
    chatId,
    scope.generation,
    input.userId,
    input.ownerId,
    input.commandId,
    result,
    now,
    sendId,
  );
  setAdminPresence(db, scope, input.userId, true);
  return findRecoveryCommand(db, input.ownerId, input.commandId)!;
}

export function createAdminRecoveryStore(connection: Connection, lifecycle: LifecycleBackend) {
  function operation(db: Database, ownerId: UserId, id: number) {
    compositeId(ownerId);
    requireInput(Number.isSafeInteger(id) && id > 0);
    return db
      .prepare(`SELECT ${columns} FROM admin_recovery_operations WHERE id=? AND owner_id=?`)
      .get(id, ownerId) as RecoveryOperation | undefined;
  }

  return {
    operation(ownerId: UserId, id: number) {
      return connection.run((db) => operation(db, ownerId, id));
    },
    command(ownerId: UserId, commandId: number) {
      return connection.run((db) => findRecoveryCommand(db, ownerId, commandId));
    },
    list(platform: string, group: (chatId: ChatId) => boolean): readonly AdministrationStatus[] {
      requireInput(/^[a-z][a-z0-9_-]*$/u.test(platform));
      return connection.run((db) => {
        const prefix = platform + ':';
        const rows = db
          .prepare(
            `SELECT c.chat_id AS chatId,c.generation,
          CASE WHEN c.state<>'active' THEN 'unknown'
            WHEN EXISTS (SELECT 1 FROM bot_admin_grants g JOIN admin_presence p
              ON p.chat_id=g.chat_id AND p.user_id=g.user_id AND p.generation=c.generation
              WHERE g.chat_id=c.chat_id AND p.present=1) THEN 'available'
            WHEN EXISTS (SELECT 1 FROM bot_admin_grants g LEFT JOIN admin_presence p
              ON p.chat_id=g.chat_id AND p.user_id=g.user_id AND p.generation=c.generation
              WHERE g.chat_id=c.chat_id AND p.present IS NULL) THEN 'unknown'
            ELSE 'missing' END AS state
          FROM chat_connections c WHERE substr(c.chat_id,1,?)=? ORDER BY c.chat_id`,
          )
          .all(prefix.length, prefix) as AdministrationStatus[];
        return rows.filter((row) => group(row.chatId));
      });
    },
    status(chatId: ChatId, ownerId: UserId) {
      compositeId(chatId);
      compositeId(ownerId);
      return connection.run((db) =>
        db
          .prepare(
            `SELECT id,generation,result,state,reason,created_at AS createdAt
        FROM admin_recovery_operations WHERE chat_id=? AND owner_id=? ORDER BY id DESC`,
          )
          .all(chatId, ownerId),
      );
    },
    communityRole(chatId: ChatId) {
      compositeId(chatId);
      const row = connection.run((db) =>
        db
          .prepare(
            `SELECT community_admin AS admin FROM admin_observations
        JOIN chat_connections USING(chat_id,generation) WHERE chat_id=? AND state='active'`,
          )
          .get(chatId),
      ) as { admin: number | null } | undefined;
      return row?.admin === 1 ? true : row?.admin === 0 ? false : 'unknown';
    },
    restoreSending(ownerId: UserId) {
      compositeId(ownerId);
      connection.run((db) =>
        db
          .prepare(
            `UPDATE admin_recovery_operations SET state='pending_delivery',reason='interrupted'
        WHERE owner_id=? AND state='sending'`,
          )
          .run(ownerId),
      );
    },
    claim(
      scope: ConnectionScope,
      ownerId: UserId,
      id: number,
      now: number,
      retryCommandId?: number,
    ) {
      timestamp(now);
      requireInput(
        retryCommandId === undefined ||
          (Number.isSafeInteger(retryCommandId) && retryCommandId > 0),
      );
      return lifecycle.transaction(scope, (db) => {
        const row = operation(db, ownerId, id);
        if (
          row?.state !== 'pending_delivery' ||
          row.chatId !== scope.chatId ||
          row.generation !== scope.generation
        )
          return undefined;
        const retry = retryCommandId ?? null;
        const wrote = db
          .prepare(
            `UPDATE admin_recovery_operations SET state='sending', attempt=attempt+1,
          attempted_at=coalesce(attempted_at,?),last_retry_command_id=coalesce(?,last_retry_command_id)
          WHERE id=? AND (? IS NULL OR last_retry_command_id<?)`,
          )
          .run(now, retry, id, retry, retry);
        return wrote.changes === 1 ? operation(db, ownerId, id) : undefined;
      });
    },
    recordReceipt(scope: ConnectionScope, claim: RecoveryOperation, receipt: string) {
      requireInput(/^[1-9]\d*$/u.test(receipt));
      lifecycle.transaction(scope, (db) =>
        db
          .prepare(
            `UPDATE admin_recovery_operations SET receipt=?
        WHERE id=? AND chat_id=? AND generation=? AND owner_id=? AND state='sending' AND attempt=?`,
          )
          .run(receipt, claim.id, scope.chatId, scope.generation, claim.ownerId, claim.attempt),
      );
    },
    finish(scope: ConnectionScope, claim: RecoveryOperation, reason: RecoveryReason | null) {
      lifecycle.transaction(scope, (db) =>
        db
          .prepare(
            `UPDATE admin_recovery_operations SET state=?,reason=?
        WHERE id=? AND chat_id=? AND generation=? AND owner_id=? AND state='sending' AND attempt=?`,
          )
          .run(
            reason ? 'pending_delivery' : 'delivered',
            reason,
            claim.id,
            scope.chatId,
            scope.generation,
            claim.ownerId,
            claim.attempt,
          ),
      );
    },
  };
}

const stores = new WeakMap<Storage, ReturnType<typeof createAdminRecoveryStore>>();
export function registerAdminRecovery(
  storage: Storage,
  store: ReturnType<typeof createAdminRecoveryStore>,
) {
  stores.set(storage, store);
}
export function adminRecoveryStore(storage: Storage) {
  const store = stores.get(storage);
  requireInput(store);
  return store;
}
