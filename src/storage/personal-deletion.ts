import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { ConnectionScope, UserId } from '../contracts/index';
import { requireInput, timestamp } from './validation';

export function deletionRequest(
  db: Database,
  scope: ConnectionScope,
  user: UserId,
  event: string,
  now: number,
) {
  timestamp(now);
  db.prepare(
    `INSERT INTO personal_deletions(code,chat_id,generation,user_id,request_event,requested_at)
    VALUES(?,?,?,?,?,?) ON CONFLICT(chat_id,generation,user_id,request_event) DO NOTHING`,
  ).run(randomBytes(12).toString('hex'), scope.chatId, scope.generation, user, event, now);
  return db
    .prepare(
      `SELECT code,requested_at AS requestedAt,(SELECT title FROM chats WHERE chat_id=?) AS title
    FROM personal_deletions WHERE chat_id=? AND generation=? AND user_id=? AND request_event=?`,
    )
    .get(scope.chatId, scope.chatId, scope.generation, user, event) as {
    code: string;
    requestedAt: number;
    title: string | null;
  };
}

export function invalidateDependentData(db: Database, chat: string, code: string) {
  db.prepare(
    `WITH RECURSIVE affected(id) AS (
      SELECT message_id FROM personal_hidden_messages WHERE code=?
      UNION SELECT a.answer_id FROM personal_answer_sources a JOIN affected ON affected.id=a.source_id
    ) INSERT OR IGNORE INTO personal_hidden_messages SELECT id,?,1 FROM affected`,
  ).run(code, code);
  db.prepare(
    `DELETE FROM queue_jobs WHERE chat_id=? AND (message_id IN (SELECT message_id FROM personal_hidden_messages) OR id IN (SELECT job_id FROM response_traces WHERE
    EXISTS(SELECT 1 FROM json_each(payload,'$.context.messageIds') j JOIN personal_hidden_messages h ON h.message_id=j.value)))`,
  ).run(chat);
  db.prepare(
    `DELETE FROM profile_facts WHERE chat_id=? AND source_message_id IN (
  SELECT m.platform_message_id FROM personal_hidden_messages h JOIN messages m ON m.id=h.message_id WHERE h.code=?
  )`,
  ).run(chat, code);
}

export function confirmDeletion(
  db: Database,
  scope: ConnectionScope,
  user: UserId,
  code: string,
  now: number,
) {
  timestamp(now);
  const chat = scope.chatId;
  const changed = db
    .prepare(
      `UPDATE personal_deletions SET confirmed_at=?,cutoff_id=(SELECT coalesce(max(id),0) FROM messages WHERE chat_id=?)
    WHERE chat_id=? AND generation=? AND user_id=? AND code=? AND requested_at<=? AND requested_at+900000>? AND confirmed_at IS NULL`,
    )
    .run(now, chat, chat, scope.generation, user, code, now, now);
  if (!changed.changes) return false;
  db.prepare(
    'DELETE FROM questionnaire_inputs WHERE chat_id=? AND generation=? AND message_id IN (SELECT id FROM messages WHERE chat_id=? AND user_id=?)',
  ).run(chat, scope.generation, chat, user);
  db.prepare(
    'DELETE FROM questionnaire_progress WHERE chat_id=? AND generation=? AND user_id=?',
  ).run(chat, scope.generation, user);
  db.prepare(
    `INSERT OR IGNORE INTO personal_hidden_messages SELECT id,?,0 FROM messages WHERE chat_id=? AND user_id=? AND role='user'`,
  ).run(code, chat, user);
  db.prepare(
    `INSERT OR IGNORE INTO history_deleted_inputs SELECT chat_id,?,platform_message_id FROM messages WHERE chat_id=? AND user_id=? AND role='user'`,
  ).run(scope.generation, chat, user);
  // Для прежних ответов без связей с источниками требуется разбор, если текст мог зависеть от удаляемой истории.
  db.prepare(
    `INSERT OR IGNORE INTO personal_hidden_messages
    SELECT m.id,?,1 FROM messages m WHERE m.chat_id=? AND m.role='assistant' AND m.purpose='conversation'
    AND m.id>(SELECT min(message_id) FROM personal_hidden_messages WHERE code=?)
    AND NOT EXISTS(SELECT 1 FROM personal_answer_sources a WHERE a.answer_id=m.id)`,
  ).run(code, chat, code);
  const inputs =
    "SELECT platform_message_id FROM messages WHERE chat_id=? AND user_id=? AND role='user'";
  db.prepare(
    `INSERT OR IGNORE INTO personal_hidden_messages SELECT id,?,1 FROM messages WHERE chat_id=? AND role='assistant' AND reply_to_message_id IN (${inputs})`,
  ).run(code, chat, chat, user);
  db.prepare(
    `UPDATE messages SET reply_to_message_id=NULL WHERE chat_id=? AND reply_to_message_id IN (${inputs})`,
  ).run(chat, chat, user);
  db.prepare(
    `INSERT OR IGNORE INTO personal_hidden_messages
    SELECT s.answer_id,?,1 FROM tool_answer_subjects s JOIN messages m ON m.id=s.answer_id
    WHERE m.chat_id=? AND s.user_id=?`,
  ).run(code, chat, user);
  db.prepare(
    `DELETE FROM tool_answer_subjects WHERE user_id=? AND answer_id IN
    (SELECT id FROM messages WHERE chat_id=?)`,
  ).run(user, chat);
  db.prepare(
    `INSERT OR IGNORE INTO personal_hidden_messages
    SELECT w.message_id,?,0 FROM greeting_windows w JOIN greeting_members g ON g.window_id=w.id
    WHERE w.chat_id=? AND w.generation=? AND g.user_id=? AND g.greet=1 AND w.message_id IS NOT NULL`,
  ).run(code, chat, scope.generation, user);
  db.prepare(
    `INSERT OR IGNORE INTO personal_hidden_messages
    SELECT w.invitation_message_id,?,0 FROM greeting_windows w JOIN greeting_members g ON g.window_id=w.id
    WHERE w.chat_id=? AND w.generation=? AND g.user_id=? AND g.invited=1 AND w.invitation_message_id IS NOT NULL`,
  ).run(code, chat, scope.generation, user);
  db.prepare('DELETE FROM greeting_candidates WHERE chat_id=? AND generation=? AND user_id=?').run(
    chat,
    scope.generation,
    user,
  );
  db.prepare(
    `DELETE FROM greeting_members WHERE user_id=? AND window_id IN (
    SELECT id FROM greeting_windows WHERE chat_id=? AND generation=?
  )`,
  ).run(user, chat, scope.generation);
  db.prepare(
    `UPDATE greeting_windows SET state='skipped' WHERE chat_id=? AND generation=?
    AND state='waiting' AND NOT EXISTS(SELECT 1 FROM greeting_members WHERE window_id=greeting_windows.id)`,
  ).run(chat, scope.generation);
  db.prepare(
    `UPDATE greeting_windows SET invitation_state='skipped' WHERE chat_id=? AND generation=?
    AND invitation_state='waiting' AND NOT EXISTS(
      SELECT 1 FROM greeting_members WHERE window_id=greeting_windows.id AND invitation<>0)`,
  ).run(chat, scope.generation);
  db.prepare(
    `DELETE FROM profile_command_lists WHERE user_id=?
    AND (chat_id=? AND generation=? OR user_id=? AND private_generation=?)`,
  ).run(user, chat, scope.generation, chat, scope.generation);
  db.prepare(
    'DELETE FROM profile_command_events WHERE chat_id=? AND generation=? AND user_id=?',
  ).run(chat, scope.generation, user);
  db.prepare(
    `UPDATE chat_passport_prompts SET actor_id=NULL,action=NULL,revision=NULL,expires_at=NULL
    WHERE chat_id=? AND generation=? AND actor_id=?`,
  ).run(chat, scope.generation, user);
  db.prepare(
    `UPDATE questionnaire_editor_prompts SET actor_id=NULL,shown_revision=NULL
    WHERE chat_id=? AND generation=? AND actor_id=?`,
  ).run(chat, scope.generation, user);
  invalidateDependentData(db, chat, code);
  db.prepare(
    `DELETE FROM profile_facts WHERE chat_id=? AND (user_id=? OR source_user_id=? OR source_message_id IN (${inputs}))`,
  ).run(chat, user, user, chat, user);
  db.prepare('DELETE FROM address_preferences WHERE chat_id=? AND generation=? AND user_id=?').run(
    chat,
    scope.generation,
    user,
  );
  db.prepare('DELETE FROM participant_profiles WHERE chat_id=? AND user_id=?').run(chat, user);
  db.prepare('DELETE FROM chat_participants WHERE chat_id=? AND user_id=?').run(chat, user);
  db.prepare(
    `UPDATE chat_connections SET erased_author_number=max(erased_author_number,coalesce((
      SELECT author_number FROM chat_author_labels WHERE chat_id=? AND generation=? AND user_id=?),0))
      WHERE chat_id=? AND generation=?`,
  ).run(chat, scope.generation, user, chat, scope.generation);
  for (const [table, column] of [
    ['chat_author_labels', 'user_id'],
    ['request_quota_admissions', 'user_id'],
    ['chat_control_commands', 'actor_id'],
    ['history_clear_requests', 'initiator_id'],
    ['admin_recovery_operations', 'user_id'],
    ['admin_recovery_operations', 'owner_id'],
    ['personal_exports', 'user_id'],
    ['personal_profile_choices', 'user_id'],
  ])
    db.prepare(`DELETE FROM ${table} WHERE chat_id=? AND generation=? AND ${column}=?`).run(
      chat,
      scope.generation,
      user,
    );
  db.prepare(
    'INSERT OR IGNORE INTO personal_retained_denials SELECT chat_id,?,user_id FROM bot_admin_revocations WHERE chat_id=? AND (user_id=? OR revoked_by=?)',
  ).run(scope.generation, chat, user, user);
  db.prepare(
    'DELETE FROM bot_admin_revocation_audit WHERE chat_id=? AND user_id IN (SELECT user_id FROM personal_retained_denials WHERE chat_id=? AND generation=?)',
  ).run(chat, chat, scope.generation);
  db.prepare(
    'DELETE FROM bot_admin_revocations WHERE chat_id=? AND (user_id=? OR revoked_by=?)',
  ).run(chat, user, user);
  db.prepare('UPDATE bot_admin_grants SET granted_by=NULL WHERE chat_id=? AND granted_by=?').run(
    chat,
    user,
  );
  db.prepare("DELETE FROM bot_admin_grants WHERE chat_id=? AND user_id=? AND basis='explicit'").run(
    chat,
    user,
  );
  db.prepare(
    'DELETE FROM admin_presence WHERE chat_id=? AND user_id=? AND NOT EXISTS(SELECT 1 FROM bot_admin_grants WHERE chat_id=? AND user_id=?)',
  ).run(chat, user, chat, user);
  db.prepare(
    'UPDATE admin_observations SET invite_actor=NULL WHERE chat_id=? AND invite_actor=?',
  ).run(chat, user);
  db.prepare(
    'DELETE FROM mention_flood_inputs WHERE chat_id=? AND message_id IN (SELECT message_id FROM personal_hidden_messages WHERE code=?)',
  ).run(chat, code);
  db.prepare(
    'DELETE FROM autonomous_questions WHERE chat_id=? AND message_id IN (SELECT message_id FROM personal_hidden_messages WHERE code=?)',
  ).run(chat, code);
  db.prepare(
    'DELETE FROM personal_reminder_inputs WHERE source_chat_id=? AND target_chat_id=?',
  ).run(chat, user);
  if (chat === user) {
    db.prepare('DELETE FROM personal_reminders WHERE chat_id=? AND generation=?').run(
      chat,
      scope.generation,
    );
    db.prepare(
      'DELETE FROM personal_reminder_inputs WHERE target_chat_id=? AND target_generation=?',
    ).run(chat, scope.generation);
    db.prepare('DELETE FROM personal_reminder_timezones WHERE chat_id=? AND generation=?').run(
      chat,
      scope.generation,
    );
  }
  db.prepare(
    'DELETE FROM personal_deletions WHERE chat_id=? AND generation=? AND user_id=? AND confirmed_at IS NULL',
  ).run(chat, scope.generation, user);
  const remaining = db
    .prepare(
      `SELECT 1 FROM chat_participants WHERE chat_id=@chat AND user_id=@user
    UNION ALL SELECT 1 FROM address_preferences WHERE chat_id=@chat AND user_id=@user
    UNION ALL SELECT 1 FROM profile_command_lists WHERE user_id=@user AND (chat_id=@chat OR user_id=@chat)
    UNION ALL SELECT 1 FROM profile_command_events WHERE chat_id=@chat AND user_id=@user
    UNION ALL SELECT 1 FROM chat_passport_prompts WHERE chat_id=@chat AND actor_id=@user
    UNION ALL SELECT 1 FROM questionnaire_progress WHERE chat_id=@chat AND user_id=@user
    UNION ALL SELECT 1 FROM questionnaire_editor_prompts WHERE chat_id=@chat AND actor_id=@user
    UNION ALL SELECT 1 FROM greeting_candidates WHERE chat_id=@chat AND user_id=@user
    UNION ALL SELECT 1 FROM greeting_members g JOIN greeting_windows w ON w.id=g.window_id
      WHERE w.chat_id=@chat AND g.user_id=@user
    UNION ALL SELECT 1 FROM participant_profiles WHERE chat_id=@chat AND user_id=@user
    UNION ALL SELECT 1 FROM profile_facts WHERE chat_id=@chat AND (user_id=@user OR source_user_id=@user)
    UNION ALL SELECT 1 FROM personal_exports WHERE chat_id=@chat AND user_id=@user
    UNION ALL SELECT 1 FROM personal_profile_choices WHERE chat_id=@chat AND user_id=@user
    UNION ALL SELECT 1 FROM chat_author_labels WHERE chat_id=@chat AND user_id=@user
    UNION ALL SELECT 1 FROM request_quota_admissions WHERE chat_id=@chat AND user_id=@user
    UNION ALL SELECT 1 FROM chat_control_commands WHERE chat_id=@chat AND actor_id=@user
    UNION ALL SELECT 1 FROM history_clear_requests WHERE chat_id=@chat AND initiator_id=@user
    UNION ALL SELECT 1 FROM admin_recovery_operations WHERE chat_id=@chat AND (user_id=@user OR owner_id=@user)
    UNION ALL SELECT 1 FROM bot_admin_revocation_audit WHERE chat_id=@chat AND user_id=@user
    UNION ALL SELECT 1 FROM personal_visible_messages WHERE chat_id=@chat AND user_id=@user AND role='user'
    UNION ALL SELECT 1 FROM personal_reminders WHERE chat_id=@chat AND chat_id=@user
    LIMIT 1`,
    )
    .get({ chat, user });
  requireInput(!remaining);
  return true;
}

export function purgePersonalMessages(db: Database, now: number) {
  timestamp(now);
  const removed = db
    .prepare(
      'DELETE FROM messages WHERE id IN (SELECT message_id FROM personal_hidden_messages WHERE disputed=0 LIMIT 100)',
    )
    .run().changes;
  db.prepare(
    `UPDATE personal_deletions SET verified_at=max(?,confirmed_at) WHERE confirmed_at IS NOT NULL AND verified_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM personal_hidden_messages h WHERE h.code=personal_deletions.code)
    AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.chat_id=personal_deletions.chat_id AND m.user_id=personal_deletions.user_id AND m.id<=cutoff_id AND m.role='user')
    AND NOT EXISTS(SELECT 1 FROM participant_profiles p WHERE p.chat_id=personal_deletions.chat_id AND p.user_id=personal_deletions.user_id)`,
  ).run(now);
  return removed;
}
