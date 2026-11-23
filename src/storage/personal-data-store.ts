import {
  deletionRequest,
  confirmDeletion,
  purgePersonalMessages,
  invalidateDependentData,
} from './personal-deletion';
import { readPersonalExport } from './personal-export';
import type { Database } from 'better-sqlite3';
import type { ConnectionScope, UserId } from '../contracts/index';
import type { Connection } from './connection';
import type { LifecycleBackend } from './lifecycle-store';
import type { Storage } from './types';
import { compositeId, requireInput, timestamp } from './validation';

const week = 7 * 86_400_000;

function parameters(scope: ConnectionScope, userId: UserId) {
  compositeId(userId);
  requireInput(userId.split(':')[0] === scope.chatId.split(':')[0]);
  return { chat: scope.chatId, generation: scope.generation, user: userId };
}
const subject = 'chat_id=@chat AND generation=@generation AND user_id=@user';

function admitted(db: Database, scope: ConnectionScope, userId: UserId, sourceTime: number) {
  timestamp(sourceTime);
  const row = db
    .prepare(
      `SELECT 1 FROM disclosure_publications p
    JOIN disclosure_versions d USING(version)
    WHERE p.chat_id=@chat AND p.generation=@generation AND p.state='delivered'
      AND p.kind IN ('introduction','update') AND d.profile_notice IS NOT NULL
      AND d.required_version=(SELECT required_version FROM disclosure_versions ORDER BY version DESC LIMIT 1)
      AND p.delivered_at<@sourceTime
      AND NOT EXISTS (SELECT 1 FROM personal_profile_choices WHERE ${subject})
      AND NOT EXISTS (SELECT 1 FROM personal_deletions WHERE ${subject} AND confirmed_at IS NOT NULL)
    LIMIT 1`,
    )
    .get({ ...parameters(scope, userId), sourceTime });
  return Boolean(row);
}

export function createPersonalDataStore(connection: Connection, lifecycle: LifecycleBackend) {
  return {
    recordAnswerSources(
      db: Database,
      scope: ConnectionScope,
      messageId: string,
      sources: readonly number[],
    ) {
      requireInput(db.inTransaction);
      db.prepare(
        `INSERT OR IGNORE INTO personal_answer_sources(answer_id,source_id)
        SELECT a.id,s.id FROM messages a JOIN messages s ON s.chat_id=a.chat_id
        WHERE a.chat_id=? AND a.platform_message_id=? AND s.id IN (SELECT value FROM json_each(?))`,
      ).run(scope.chatId, messageId, JSON.stringify(sources));
    },
    profileAllowed(scope: ConnectionScope, userId: UserId, sourceTime: number) {
      return lifecycle.transaction(scope, (db) => admitted(db, scope, userId, sourceTime));
    },
    withProfileAdmission<T>(
      scope: ConnectionScope,
      userId: UserId,
      sourceTime: number,
      operation: (db: Database) => T,
    ) {
      return lifecycle.transaction(scope, (db) =>
        admitted(db, scope, userId, sourceTime) ? operation(db) : undefined,
      );
    },
    hasData(scope: ConnectionScope, userId: UserId) {
      return lifecycle.transaction(scope, (db) => {
        const args = parameters(scope, userId);
        return (
          scope.chatId === userId ||
          Boolean(
            db
              .prepare(
                `SELECT 1 FROM chat_participants WHERE chat_id=@chat AND user_id=@user
          UNION ALL SELECT 1 FROM messages WHERE chat_id=@chat AND user_id=@user AND role='user'
          UNION ALL SELECT 1 FROM active_admin_denials WHERE chat_id=@chat AND user_id=@user
          UNION ALL SELECT 1 FROM bot_admin_grants WHERE chat_id=@chat AND user_id=@user
          UNION ALL SELECT 1 FROM chat_author_labels WHERE ${subject}
          UNION ALL SELECT 1 FROM personal_profile_choices WHERE ${subject}
          UNION ALL SELECT 1 FROM personal_deletions WHERE ${subject} LIMIT 1`,
              )
              .get(args),
          )
        );
      });
    },
    beginExport(scope: ConnectionScope, userId: UserId, event: string) {
      return lifecycle.transaction(scope, (db) =>
        Boolean(
          db
            .prepare(
              `INSERT OR IGNORE INTO personal_exports(chat_id,generation,user_id,event)
        SELECT @chat,@generation,@user,@event WHERE NOT EXISTS (SELECT 1 FROM personal_deletions WHERE ${subject} AND confirmed_at IS NOT NULL AND verified_at IS NULL)`,
            )
            .run({ ...parameters(scope, userId), event }).changes,
        ),
      );
    },
    finishExport(scope: ConnectionScope, userId: UserId, event: string) {
      return lifecycle.transaction(scope, (db) =>
        db
          .prepare(`UPDATE personal_exports SET delivered=1 WHERE ${subject} AND event=@event`)
          .run({ ...parameters(scope, userId), event }),
      );
    },
    export(scope: ConnectionScope, userId: UserId, now: number) {
      timestamp(now);
      requireInput(this.hasData(scope, userId));
      return lifecycle.transaction(scope, (db) => readPersonalExport(db, scope, userId, now));
    },
    disable(scope: ConnectionScope, userId: UserId, now: number) {
      timestamp(now);
      return lifecycle.transaction(scope, (db) => {
        const args = parameters(scope, userId);
        db.prepare(
          `INSERT INTO personal_profile_choices(chat_id,generation,user_id,disabled_at)
          VALUES(@chat,@generation,@user,@now) ON CONFLICT DO NOTHING`,
        ).run({ ...args, now });
        const row = db
          .prepare(`SELECT disabled_at FROM personal_profile_choices WHERE ${subject}`)
          .get(args) as { disabled_at: number };
        return row.disabled_at + week;
      });
    },
    reportMessage(scope: ConnectionScope, user: UserId, messageId: string) {
      return lifecycle.transaction(scope, (db) => {
        const row = db
          .prepare(
            `SELECT code,cutoff_id FROM personal_deletions WHERE ${subject} AND confirmed_at IS NOT NULL ORDER BY confirmed_at DESC LIMIT 1`,
          )
          .get(parameters(scope, user)) as { code: string; cutoff_id: number } | undefined;
        if (!row) return false;
        const hidden = db
          .prepare(
            `INSERT OR IGNORE INTO personal_hidden_messages(message_id,code,disputed) SELECT id,?,1 FROM messages WHERE chat_id=? AND platform_message_id=? AND id<=?`,
          )
          .run(row.code, scope.chatId, messageId, row.cutoff_id).changes;
        if (hidden) {
          invalidateDependentData(db, scope.chatId, row.code);
          db.prepare('UPDATE personal_deletions SET verified_at=NULL WHERE code=?').run(row.code);
        }
        return Boolean(hidden);
      });
    },
    disputed(scope: ConnectionScope) {
      return lifecycle.transaction(
        scope,
        (db) =>
          db
            .prepare(
              `SELECT DISTINCT m.platform_message_id AS messageId FROM personal_hidden_messages h JOIN messages m ON m.id=h.message_id WHERE h.disputed=1 AND m.chat_id=? ORDER BY m.id LIMIT 20`,
            )
            .all(scope.chatId) as { messageId: string }[],
      );
    },
    resolveDisputed(scope: ConnectionScope, messageId: string, decision: 'erase' | 'keep') {
      return lifecycle.transaction(scope, (db) => {
        const row = db
          .prepare(
            `SELECT id FROM messages m WHERE chat_id=? AND platform_message_id=? AND EXISTS(SELECT 1 FROM personal_hidden_messages WHERE message_id=m.id AND disputed=1)`,
          )
          .get(scope.chatId, messageId) as { id: number } | undefined;
        if (!row) return false;
        if (decision === 'keep')
          db.prepare('DELETE FROM personal_hidden_messages WHERE message_id=? AND disputed=1').run(
            row.id,
          );
        else {
          db.prepare('INSERT OR IGNORE INTO history_deleted_inputs VALUES(?,?,?)').run(
            scope.chatId,
            scope.generation,
            messageId,
          );
          db.prepare('UPDATE personal_hidden_messages SET disputed=0 WHERE message_id=?').run(
            row.id,
          );
        }
        return true;
      });
    },
    status(scope: ConnectionScope, user: UserId, now: number) {
      return lifecycle.transaction(scope, (db) => {
        const args = parameters(scope, user);
        const row = db
          .prepare(
            `SELECT confirmed_at, verified_at, (SELECT count(*) FROM personal_hidden_messages WHERE code=d.code AND disputed=1) AS disputes FROM personal_deletions d WHERE ${subject} AND confirmed_at IS NOT NULL ORDER BY confirmed_at DESC,rowid DESC LIMIT 1`,
          )
          .get(args) as
          { confirmed_at: number | null; verified_at: number | null; disputes: number } | undefined;
        if (!row || row.confirmed_at === null) return 'Подтверждённого удаления пока нет.';
        const progress =
          row.verified_at !== null
            ? 'Очистка рабочей базы проверена.'
            : row.disputes
              ? 'Есть скрытые сообщения для разбора владельцем.'
              : 'Идёт очистка рабочей базы.';
        const overdue =
          row.verified_at === null && now - row.confirmed_at >= 86_400_000
            ? ' Истёк срок очистки 24 часа.'
            : '';
        const protectedRole = db
          .prepare(
            "SELECT 1 FROM bot_admin_grants WHERE chat_id=? AND user_id=? AND basis IN ('creator','inviter')",
          )
          .get(scope.chatId, user);
        const revoked = db
          .prepare('SELECT 1 FROM active_admin_denials WHERE chat_id=? AND user_id=?')
          .get(scope.chatId, user);
        return (
          progress +
          overdue +
          (protectedRole
            ? ' Для сохранения защищённых прав оставлены технический идентификатор и основание.'
            : '') +
          (revoked ? ' Сохранён технический запрет на автоматический возврат прав.' : '') +
          ' Срок хранения резервных копий — до 30 суток. Удаление из копий отдельно не подтверждено.'
        );
      });
    },
    requestDeletion(scope: ConnectionScope, user: UserId, event: string, now: number) {
      requireInput(this.hasData(scope, user));
      return lifecycle.transaction(scope, (db) => deletionRequest(db, scope, user, event, now));
    },
    deletionScope(user: UserId, code: string) {
      return connection.run((db) =>
        db
          .prepare(
            'SELECT chat_id AS chatId,generation FROM personal_deletions WHERE user_id=? AND code=?',
          )
          .get(user, code),
      ) as Pick<ConnectionScope, 'chatId' | 'generation'> | undefined;
    },
    confirmDeletion(scope: ConnectionScope, user: UserId, code: string, now: number) {
      return lifecycle.transaction(scope, (db) => confirmDeletion(db, scope, user, code, now));
    },
    cleanup(now: number) {
      return connection.run((db) =>
        db.transaction(() => purgePersonalMessages(db, now)).immediate(),
      );
    },
    purgeExpired(now: number) {
      timestamp(now);
      return connection.run((db) =>
        db
          .transaction(() => {
            const rows = db
              .prepare(
                `SELECT chat_id AS chat,generation,user_id AS user FROM personal_profile_choices
          WHERE purged_at IS NULL AND disabled_at<=? ORDER BY disabled_at LIMIT 100`,
              )
              .all(now - week) as { chat: string; generation: number; user: string }[];
            for (const row of rows) {
              db.prepare('DELETE FROM profile_facts WHERE chat_id=? AND user_id=?').run(
                row.chat,
                row.user,
              );
              db.prepare('DELETE FROM participant_profiles WHERE chat_id=? AND user_id=?').run(
                row.chat,
                row.user,
              );
              db.prepare(`UPDATE personal_profile_choices SET purged_at=@now WHERE ${subject}`).run(
                { ...row, now },
              );
            }
            return rows.length;
          })
          .immediate(),
      );
    },
  };
}

type PersonalDataStore = ReturnType<typeof createPersonalDataStore>;
const stores = new WeakMap<Storage, PersonalDataStore>();
export function registerPersonalData(storage: Storage, store: PersonalDataStore) {
  stores.set(storage, store);
}
export function personalDataStore(storage: Storage) {
  const store = stores.get(storage);
  requireInput(store);
  return store;
}
