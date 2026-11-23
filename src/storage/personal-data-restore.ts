import type { Database } from 'better-sqlite3';
import type { ConnectionScope, UserId } from '../contracts/index';
import {
  confirmDeletion,
  purgePersonalMessages,
  invalidateDependentData,
} from './personal-deletion';
import { requireInput } from './validation';

/** Вход для будущего восстановления F9.3. Файл ещё изолирован от приложения. */
export function reconcileStagedPersonalData(staged: Database, newer: Database, now: number) {
  requireInput(
    staged.name !== newer.name &&
      newer.readonly &&
      !staged.inTransaction &&
      staged.pragma('foreign_keys', { simple: true }) === 1,
  );
  const currentScope = newer.prepare(
    'SELECT 1 FROM chat_connections WHERE chat_id=? AND generation=?',
  );
  for (const row of staged.prepare('SELECT chat_id,generation FROM chat_connections').all() as {
    chat_id: string;
    generation: number;
  }[])
    requireInput(currentScope.get(row.chat_id, row.generation));
  const deletions = newer
    .prepare(
      `SELECT code,chat_id AS chatId,generation,user_id AS userId,requested_at,request_event,confirmed_at
    FROM personal_deletions WHERE confirmed_at IS NOT NULL ORDER BY confirmed_at,code`,
    )
    .all() as (ConnectionScope & {
    code: string;
    userId: UserId;
    requested_at: number;
    request_event: string;
    confirmed_at: number;
  })[];
  staged
    .transaction(() => {
      for (const operation of deletions) {
        const existing = staged
          .prepare('SELECT generation FROM chat_connections WHERE chat_id=?')
          .get(operation.chatId) as { generation: number } | undefined;
        if (!existing) continue;
        requireInput(existing.generation === operation.generation);
        staged
          .prepare(
            `INSERT OR IGNORE INTO personal_deletions(code,chat_id,generation,user_id,request_event,requested_at) VALUES(?,?,?,?,?,?)`,
          )
          .run(
            operation.code,
            operation.chatId,
            operation.generation,
            operation.userId,
            operation.request_event,
            operation.requested_at,
          );
        confirmDeletion(
          staged,
          operation,
          operation.userId,
          operation.code,
          operation.confirmed_at,
        );
        requireInput(
          staged
            .prepare('SELECT 1 FROM personal_deletions WHERE code=? AND confirmed_at=?')
            .get(operation.code, operation.confirmed_at),
        );
      }
      for (const operation of deletions) {
        const rows = newer
          .prepare(
            `SELECT m.platform_message_id AS id,h.disputed FROM personal_hidden_messages h JOIN messages m ON m.id=h.message_id WHERE h.code=?`,
          )
          .all(operation.code) as { id: string; disputed: number }[];
        for (const row of rows)
          staged
            .prepare(
              `INSERT OR REPLACE INTO personal_hidden_messages(message_id,code,disputed)
          SELECT id,?,? FROM messages WHERE chat_id=? AND platform_message_id=? AND EXISTS(SELECT 1 FROM personal_deletions WHERE code=?)`,
            )
            .run(operation.code, row.disputed, operation.chatId, row.id, operation.code);
        const deleted = newer
          .prepare(
            'SELECT platform_message_id FROM history_deleted_inputs WHERE chat_id=? AND generation=?',
          )
          .pluck()
          .all(operation.chatId, operation.generation) as string[];
        for (const id of deleted) {
          staged
            .prepare(
              `INSERT OR IGNORE INTO history_deleted_inputs SELECT chat_id,generation,? FROM chat_connections WHERE chat_id=? AND generation=?`,
            )
            .run(id, operation.chatId, operation.generation);
          staged
            .prepare(
              `INSERT OR REPLACE INTO personal_hidden_messages SELECT id,?,0 FROM messages WHERE chat_id=? AND platform_message_id=? AND EXISTS(SELECT 1 FROM personal_deletions WHERE code=?)`,
            )
            .run(operation.code, operation.chatId, id, operation.code);
        }
        invalidateDependentData(staged, operation.chatId, operation.code);
      }
      const choices = newer.prepare('SELECT * FROM personal_profile_choices').all() as {
        chat_id: string;
        generation: number;
        user_id: string;
        disabled_at: number;
        purged_at: number | null;
      }[];
      for (const choice of choices) {
        const saved = staged
          .prepare(
            `INSERT OR REPLACE INTO personal_profile_choices
          SELECT chat_id,generation,@user_id,@disabled_at,@purged_at FROM chat_connections WHERE chat_id=@chat_id AND generation=@generation`,
          )
          .run(choice);
        if (
          saved.changes &&
          (choice.purged_at !== null || now - choice.disabled_at >= 7 * 86400000)
        ) {
          staged
            .prepare('DELETE FROM profile_facts WHERE chat_id=? AND user_id=?')
            .run(choice.chat_id, choice.user_id);
          staged
            .prepare('DELETE FROM participant_profiles WHERE chat_id=? AND user_id=?')
            .run(choice.chat_id, choice.user_id);
        }
      }
      while (purgePersonalMessages(staged, now) > 0) {
        /* Проверяем следующую порцию внутри той же изолированной операции. */
      }
      for (const operation of deletions) {
        requireInput(
          !staged
            .prepare(
              `SELECT 1 FROM personal_visible_messages m JOIN personal_deletions d ON d.chat_id=m.chat_id AND d.user_id=m.user_id
        WHERE d.code=? AND m.id<=d.cutoff_id AND m.role='user' LIMIT 1`,
            )
            .get(operation.code),
        );
      }
    })
    .immediate();
}
