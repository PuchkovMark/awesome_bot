import type { Database } from 'better-sqlite3';
import type { ChatId, RecoveryVersion, UserId } from '../contracts/index';
import type { ControlMessageEvent } from './chat-control-store';
import { claimControlMessage } from './chat-control-store';
import { createChatStore } from './chats';
import type { Connection } from './connection';
import { compositeId } from './validation';

/** Записываем границу до первого принятого сообщения после пропуска. */
export function restrictPreviousSources(db: Database, scope: RecoveryVersion) {
  const chat = scope.chatId;
  db.prepare(
    `INSERT INTO connection_source_boundaries
    SELECT @chatId,@generation,@revision,
      coalesce((SELECT max(id) FROM messages WHERE chat_id=@chatId),0),
      coalesce((SELECT max(id) FROM profile_facts WHERE chat_id=@chatId),0),
      max(coalesce((SELECT max(CAST(platform_message_id AS INTEGER)) FROM messages WHERE chat_id=@chatId),0),
        coalesce((SELECT input_through FROM connection_observations WHERE chat_id=@chatId),0)),
      coalesce((SELECT max(reminder_id) FROM personal_reminder_inputs
        WHERE source_chat_id=@chatId AND source_generation=@generation AND repeated_request=0),0)
    ON CONFLICT(chat_id) DO UPDATE SET revision=excluded.revision,
      message_floor=max(message_floor,excluded.message_floor),fact_floor=max(fact_floor,excluded.fact_floor),
      input_floor=max(input_floor,excluded.input_floor),reminder_floor=max(reminder_floor,excluded.reminder_floor)`,
  ).run(scope);
  db.prepare(
    `INSERT OR REPLACE INTO unverified_admin_grants SELECT chat_id,?,user_id,basis,granted_at,granted_by
    FROM bot_admin_grants WHERE chat_id=?`,
  ).run(scope.generation, chat);
  db.prepare('DELETE FROM bot_admin_grants WHERE chat_id=?').run(chat);
  db.prepare(
    'UPDATE chat_connections SET creator_id=NULL,inviter_id=NULL,creator_applied=0,inviter_applied=0 WHERE chat_id=?',
  ).run(chat);
  db.prepare(
    'UPDATE admin_observations SET opened_at=?,invite_selected=0,invite_revision=NULL,community_admin=NULL WHERE chat_id=?',
  ).run(Date.now(), chat);
  db.prepare(
    "UPDATE queue_jobs SET state='terminal',outcome='interrupted',owner=NULL WHERE chat_id=? AND state IN ('queued','running')",
  ).run(chat);
  for (const table of [
    'admin_presence',
    'autonomous_questions',
    'recap_clarifications',
    'greeting_candidates',
    'profile_update_waiting',
    'profile_update_runs',
    'profile_command_lists',
    'chat_passport_prompts',
    'questionnaire_management_prompts',
    'questionnaire_editor_prompts',
  ]) {
    db.prepare('DELETE FROM ' + table + ' WHERE chat_id=?').run(chat);
  }
  db.prepare(
    "UPDATE history_clear_requests SET state='invalidated' WHERE chat_id=? AND state='pending'",
  ).run(chat);
  db.prepare(
    "UPDATE greeting_windows SET state=CASE state WHEN 'waiting' THEN 'skipped' ELSE 'unknown' END WHERE chat_id=? AND state IN ('waiting','dispatching')",
  ).run(chat);
  db.prepare(
    "UPDATE greeting_windows SET invitation_state=CASE invitation_state WHEN 'waiting' THEN 'skipped' ELSE 'unknown' END WHERE chat_id=? AND invitation_state IN ('waiting','dispatching')",
  ).run(chat);
  db.prepare(
    `UPDATE questionnaire_invitation_parts SET state='unknown',next_check_at=NULL
    WHERE state IN ('sending','unknown') AND window_id IN (SELECT id FROM greeting_windows WHERE chat_id=?)`,
  ).run(chat);
  db.prepare(
    "UPDATE questionnaire_progress SET state='paused',source_id=NULL WHERE chat_id=? AND state IN ('showing','dispatching','active','processing')",
  ).run(chat);
  db.prepare(
    "UPDATE questionnaire_presentations SET state='unknown' WHERE chat_id=? AND state='sending'",
  ).run(chat);
}

const eligible = `FROM chat_connections c LEFT JOIN chats s USING(chat_id)
  LEFT JOIN chat_controls k USING(chat_id,generation)
  WHERE c.state='uncertain' AND c.established=1 AND coalesce(s.enabled,1)=1
  AND (c.pause_reason IN ('startup','observation_lost','verification_uncertain') OR c.pause_reason IS NULL)`;

export function recoveryVersion(db: Database, chatId: ChatId) {
  return db
    .prepare(
      `SELECT c.chat_id AS chatId,c.generation,c.revision,
    coalesce(k.response_revision,0) AS controlRevision ${eligible} AND c.chat_id=?`,
    )
    .get(chatId) as RecoveryVersion | undefined;
}

export function createRecoveryReader(connection: Connection) {
  const chats = createChatStore(connection);
  return {
    rememberInput(scope: { chatId: ChatId; generation: number }, sequence: number) {
      if (!Number.isSafeInteger(sequence) || sequence < 1) return;
      connection.run((db) =>
        db
          .prepare(
            `INSERT INTO connection_observations(chat_id,generation,input_through)
        SELECT c.chat_id,c.generation,? FROM chat_connections c LEFT JOIN chats s USING(chat_id)
        WHERE c.chat_id=? AND c.generation=? AND c.state='active' AND coalesce(s.enabled,1)=1
        ON CONFLICT(chat_id) DO UPDATE SET input_through=excluded.input_through WHERE input_through<excluded.input_through`,
          )
          .run(sequence, scope.chatId, scope.generation),
      );
    },
    candidate(chatId: ChatId) {
      return connection.run((db) => recoveryVersion(db, chatId));
    },
    candidates(platform: string) {
      return connection.run(
        (db) =>
          db
            .prepare(`SELECT c.chat_id ${eligible} AND c.chat_id LIKE ? ORDER BY c.chat_id`)
            .pluck()
            .all(platform + ':%') as ChatId[],
      );
    },
    setPausedEnabled(
      chatId: ChatId,
      generation: number,
      owner: UserId,
      enabled: boolean,
      event: ControlMessageEvent,
    ) {
      compositeId(chatId);
      return connection.run((db) =>
        db
          .transaction(() => {
            if (
              event.sourceChatId !== owner ||
              !db
                .prepare(
                  "SELECT 1 FROM chat_connections WHERE chat_id=? AND generation=? AND established=1 AND state='uncertain'",
                )
                .get(chatId, generation)
            )
              return undefined;
            if (claimControlMessage(db, chatId, owner, event)) {
              if (!chats.get(chatId))
                chats.create(chatId, {
                  enabled: true,
                  responseMode: 'normal',
                  createdAt: Date.now(),
                });
              chats.update(chatId, { enabled });
            }
            return chats.get(chatId)?.enabled ?? true;
          })
          .immediate(),
      );
    },
  };
}
