import type { UserId, GrantBasis } from '../contracts/index.js';
import type { Connection } from './connection.js';
import type { SyncAuthorizationStore, AuthorizationTransaction, RevocationAudit, AdminGrant } from './legacy-authorization-types.js';
import { compositeId, requireInput, string, timestamp } from './validation.js';
import { StorageError } from './errors.js';

const allBases: readonly GrantBasis[] = ['creator', 'inviter', 'explicit'];
export function createAuthorizationStore(connection: Connection): SyncAuthorizationStore {
  return {
    transaction(chatId, callback) {
      return connection.run(db => {
        compositeId(chatId);
        const scope = chatId.slice(0, chatId.indexOf(':'));
        return db.transaction(() => {
          let active = true;
          function check(userId?: UserId) {
            requireInput(active);
            if (userId !== undefined) {
              compositeId(userId);
              requireInput(userId.slice(0, userId.indexOf(':')) === scope);
            }
          }
          const tx: AuthorizationTransaction = Object.freeze({
            settings() {
              check();
              const row = db.prepare('SELECT enabled FROM chats WHERE chat_id=?').get(chatId) as { enabled: number } | undefined;
              return row ? { enabled: row.enabled === 1 } : null;
            },
            holder(basis: GrantBasis) {
              check(); requireInput(basis === 'creator' || basis === 'inviter');
              const row = db.prepare('SELECT user_id AS userId FROM bot_admin_grants WHERE chat_id=? AND basis=?').get(chatId, basis) as { userId: UserId } | undefined;
              return row?.userId ?? null;
            },
            bases(userId: UserId) {
              check(userId);
              return (db.prepare('SELECT basis FROM bot_admin_grants WHERE chat_id=? AND user_id=? ORDER BY basis').all(chatId, userId) as { basis: GrantBasis }[]).map(row => row.basis);
            },
            isRevoked(userId: UserId) {
              check(userId);
              return !!db.prepare('SELECT 1 FROM bot_admin_revocations WHERE chat_id=? AND user_id=?').get(chatId, userId);
            },
            grant(grant: AdminGrant) {
              check(grant.userId); timestamp(grant.grantedAt);
              requireInput(allBases.includes(grant.basis));
              if (grant.grantedBy !== null) compositeId(grant.grantedBy);
              db.prepare('INSERT INTO bot_admin_grants(chat_id,user_id,basis,granted_at,granted_by) VALUES (?,?,?,?,?) ON CONFLICT(chat_id,user_id,basis) DO NOTHING')
                .run(chatId, grant.userId, grant.basis, grant.grantedAt, grant.grantedBy);
            },
            remove(userId: UserId, all: boolean) {
              check(userId); requireInput(typeof all === 'boolean');
              db.prepare("DELETE FROM bot_admin_grants WHERE chat_id=? AND user_id=? AND (?=1 OR basis='explicit')").run(chatId, userId, all ? 1 : 0);
            },
            revoke(audit: Omit<RevocationAudit, 'chatId'>) {
              check(audit.userId); compositeId(audit.revokedBy); timestamp(audit.revokedAt);
              string(audit.reason, true); requireInput(audit.bases.every(basis => allBases.includes(basis)));
              db.prepare('INSERT INTO bot_admin_revocations(chat_id,user_id,revoked_by,revoked_at) VALUES (?,?,?,?)').run(chatId, audit.userId, audit.revokedBy, audit.revokedAt);
              db.prepare('INSERT INTO bot_admin_revocation_audit(chat_id,user_id,had_creator,had_inviter,had_explicit,reason) VALUES (?,?,?,?,?,?)')
                .run(chatId, audit.userId, Number(audit.bases.includes('creator')), Number(audit.bases.includes('inviter')), Number(audit.bases.includes('explicit')), audit.reason);
              tx.remove(audit.userId, true);
              db.prepare('INSERT INTO bot_admin_controls(chat_id,recovery_blocked) VALUES (?,1) ON CONFLICT DO NOTHING').run(chatId);
            },
            restore(userId: UserId) {
              check(userId);
              db.prepare('DELETE FROM bot_admin_revocation_audit WHERE chat_id=? AND user_id=?').run(chatId, userId);
              db.prepare('DELETE FROM bot_admin_revocations WHERE chat_id=? AND user_id=?').run(chatId, userId);
            },
            audit(userId: UserId): RevocationAudit | null {
              check(userId);
              const row = db.prepare(`SELECT r.user_id AS userId,r.revoked_by AS revokedBy,r.revoked_at AS revokedAt,
                a.had_creator AS creator,a.had_inviter AS inviter,a.had_explicit AS explicit,a.reason
                FROM bot_admin_revocations r JOIN bot_admin_revocation_audit a USING(chat_id,user_id)
                WHERE r.chat_id=? AND r.user_id=?`).get(chatId, userId) as { userId: UserId; revokedBy: UserId; revokedAt: number; creator: number; inviter: number; explicit: number; reason: string | null } | undefined;
              return row ? { chatId, userId: row.userId, revokedBy: row.revokedBy, revokedAt: row.revokedAt, reason: row.reason, bases: allBases.filter(basis => row[basis] === 1) } : null;
            },
            recoveryBlocked() {
              check(); return !!db.prepare('SELECT 1 FROM bot_admin_controls WHERE chat_id=?').get(chatId);
            },
          });
          try {
            const result = callback(tx);
            if (result !== null && (typeof result === 'object' || typeof result === 'function') && 'then' in result) {
              throw new StorageError('invalid_input');
            }
            return result;
          } finally { active = false; }
        }).immediate();
      });
    },
    pruneReasons(now, retentionMs) {
      return connection.run(db => {
        timestamp(now); requireInput(Number.isSafeInteger(retentionMs) && retentionMs > 0);
        return db.transaction(() => {
          const cleared = db.prepare(`UPDATE bot_admin_revocation_audit SET reason=NULL WHERE reason IS NOT NULL
            AND (chat_id,user_id) IN (SELECT chat_id,user_id FROM bot_admin_revocations WHERE revoked_at<=?)`).run(now - retentionMs).changes;
          const next = db.prepare(`SELECT MIN(r.revoked_at) AS time FROM bot_admin_revocations r
            JOIN bot_admin_revocation_audit a USING(chat_id,user_id) WHERE a.reason IS NOT NULL`).get() as { time: number | null };
          return { cleared, nextRevokedAt: next.time };
        }).immediate();
      });
    },
  };
}
