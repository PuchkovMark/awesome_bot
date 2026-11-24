import { randomBytes, randomInt } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { ConnectionVersion, UserId } from '../contracts/index';
import type { Connection } from './connection';
import { StorageError } from './errors';

interface ResetRequest extends ConnectionVersion {
  readonly code: string;
  readonly sendId: number;
  readonly state: 'pending' | 'ready' | 'cancelled' | 'confirmed' | 'closed';
  readonly title: string | null;
}
const columns = `SELECT r.code,r.chat_id AS chatId,r.generation,r.revision,r.send_id AS sendId,r.state,c.title
  FROM paused_reset_requests r LEFT JOIN chats c USING(chat_id)`;
const current = `EXISTS(SELECT 1 FROM chat_connections c WHERE c.state='uncertain' AND
  (c.chat_id,c.generation,c.revision)=(paused_reset_requests.chat_id,paused_reset_requests.generation,paused_reset_requests.revision))`;

export function claimPausedReset(
  db: Database,
  owner: UserId,
  code: string,
  selected: ConnectionVersion,
  event: number,
  now: number,
  choice: 'confirmed' | 'cancelled',
) {
  const change = db
    .prepare(
      `UPDATE paused_reset_requests SET state=?
    WHERE owner_id=? AND code=? AND chat_id=? AND generation=? AND revision=? AND state='ready'
    AND receipt<? AND expires_at>? AND ${current}`,
    )
    .run(choice, owner, code, selected.chatId, selected.generation, selected.revision, event, now);
  if (!change.changes) throw new StorageError('stale_scope');
}
export function pausedResetStore(connection: Connection) {
  return {
    request(selected: ConnectionVersion, owner: UserId, event: number) {
      return connection.run((db) =>
        db
          .transaction(() => {
            const valid = db
              .prepare(
                "SELECT 1 FROM chat_connections WHERE chat_id=? AND generation=? AND revision=? AND state='uncertain'",
              )
              .get(selected.chatId, selected.generation, selected.revision);
            if (!valid) throw new StorageError('stale_scope');
            db.prepare(
              `INSERT INTO paused_reset_requests(code,owner_id,event_id,chat_id,generation,revision,send_id,state)
          VALUES(?,?,?,?,?,?,?,'pending') ON CONFLICT(owner_id,event_id) DO NOTHING`,
            ).run(
              randomBytes(8).toString('hex'),
              owner,
              event,
              selected.chatId,
              selected.generation,
              selected.revision,
              randomInt(1, 0x7fffffff),
            );
            const row = db
              .prepare(columns + ' WHERE owner_id=? AND event_id=?')
              .get(owner, event) as ResetRequest;
            if (
              row.chatId !== selected.chatId ||
              row.generation !== selected.generation ||
              row.revision !== selected.revision
            )
              throw new StorageError('stale_scope');
            return row;
          })
          .immediate(),
      );
    },
    delivered(owner: UserId, code: string, receipt: number, now: number) {
      return connection.run(
        (db) =>
          db
            .prepare(
              `UPDATE paused_reset_requests SET state='ready',receipt=?,expires_at=?
        WHERE code=? AND owner_id=? AND state='pending' AND ${current}`,
            )
            .run(receipt, now + 900000, code, owner).changes === 1,
      );
    },
    lookup(owner: UserId, code: string) {
      return connection.run(
        (db) =>
          db.prepare(columns + ' WHERE r.owner_id=? AND r.code=?').get(owner, code) as
            ResetRequest | undefined,
      );
    },
    cancel(owner: UserId, code: string, selected: ConnectionVersion, event: number, now: number) {
      connection.run((db) => claimPausedReset(db, owner, code, selected, event, now, 'cancelled'));
    },
  };
}
