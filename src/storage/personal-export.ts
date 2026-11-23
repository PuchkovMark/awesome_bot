import type { Database } from 'better-sqlite3';
import type { ConnectionScope, UserId } from '../contracts/index';
import { historyBounds } from './history-retention-store';
import { requireInput } from './validation';

export function readPersonalExport(
  db: Database,
  scope: ConnectionScope,
  user: UserId,
  now: number,
) {
  const chat = scope.chatId,
    generation = scope.generation;
  requireInput(
    !db
      .prepare(
        'SELECT 1 FROM personal_deletions WHERE chat_id=? AND generation=? AND user_id=? AND confirmed_at IS NOT NULL AND verified_at IS NULL LIMIT 1',
      )
      .get(chat, generation, user),
  );
  const choice = db
    .prepare(
      'SELECT disabled_at AS disabledAt FROM personal_profile_choices WHERE chat_id=? AND generation=? AND user_id=?',
    )
    .get(chat, generation, user) as { disabledAt: number } | undefined;
  const visible = !choice || now - choice.disabledAt < 7 * 86_400_000;
  const bounds = historyBounds(db, chat, now);
  const title = db.prepare('SELECT title FROM chats WHERE chat_id=?').get(chat) as
    { title: string | null } | undefined;
  return {
    chat,
    title: title?.title ?? null,
    user,
    generatedAt: new Date(now).toISOString(),
    description:
      'Ваши данные в выбранной беседе. Время числовых отметок указано в миллисекундах UTC.',
    participation:
      db
        .prepare(
          'SELECT status,role,joined_at,last_seen_at FROM chat_participants WHERE chat_id=? AND user_id=?',
        )
        .get(chat, user) ?? null,
    profile: visible
      ? (db
          .prepare(
            'SELECT created_at,updated_at FROM participant_profiles WHERE chat_id=? AND user_id=?',
          )
          .get(chat, user) ?? null)
      : null,
    addressPreference: visible
      ? (db
          .prepare(
            `SELECT form,visibility,form_message_id,changed_at,'self' AS source FROM address_preferences
          WHERE chat_id=? AND generation=? AND user_id=? AND form IS NOT NULL`,
          )
          .get(chat, generation, user) ?? null)
      : null,
    facts: visible
      ? db
          .prepare(
            `SELECT field_key,value,source_kind,reliability,visibility,created_at,updated_at,source_at,
      change_kind,CASE WHEN change_kind<>'set' AND interest_key<>'' THEN interest_key END AS interest,
      CASE WHEN source_user_id=user_id AND EXISTS(
        SELECT 1 FROM personal_visible_messages m
        WHERE m.chat_id=f.chat_id AND m.user_id=f.user_id AND m.platform_message_id=f.source_message_id
          AND m.id>? AND m.timestamp>?
      ) THEN source_message_id END AS own_source_message
      FROM profile_facts f WHERE chat_id=? AND user_id=? AND (generation=? OR generation IS NULL)
      ORDER BY id`,
          )
          .all(bounds.clearedThrough, bounds.expiredThrough, chat, user, generation)
      : [],
    messages: db
      .prepare(
        `SELECT platform_message_id,text,timestamp,author_name FROM personal_visible_messages
      WHERE chat_id=? AND user_id=? AND role='user' AND id>? AND timestamp>? ORDER BY timestamp,id`,
      )
      .all(chat, user, bounds.clearedThrough, bounds.expiredThrough),
    notices: db
      .prepare(
        "SELECT version,delivered_at FROM disclosure_publications WHERE chat_id=? AND generation=? AND state='delivered' AND kind<>'owner' ORDER BY id",
      )
      .all(chat, generation),
    serviceRecords: {
      greetingEntries: db
        .prepare(
          `SELECT g.confirmed_at,w.due_at,w.state
        FROM greeting_members g JOIN greeting_windows w ON w.id=g.window_id
        WHERE w.chat_id=? AND w.generation=? AND g.user_id=? ORDER BY g.confirmed_at,w.id`,
        )
        .all(chat, generation, user),
      greetingCandidate:
        db
          .prepare(
            `SELECT source_at FROM greeting_candidates
        WHERE chat_id=? AND generation=? AND user_id=?`,
          )
          .get(chat, generation, user) ?? null,
      authorLabel:
        db
          .prepare(
            'SELECT author_number FROM chat_author_labels WHERE chat_id=? AND generation=? AND user_id=?',
          )
          .get(chat, generation, user) ?? null,
      requestAdmissions: db
        .prepare(
          'SELECT admitted_at FROM request_quota_admissions WHERE chat_id=? AND generation=? AND user_id=? ORDER BY admitted_at',
        )
        .all(chat, generation, user),
      administrativePresence:
        db
          .prepare(
            'SELECT present FROM admin_presence WHERE chat_id=? AND generation=? AND user_id=?',
          )
          .get(chat, generation, user) ?? null,
      historyRequests: db
        .prepare(
          'SELECT state,expires_at FROM history_clear_requests WHERE chat_id=? AND generation=? AND initiator_id=?',
        )
        .all(chat, generation, user),
      previousDeletions: db
        .prepare(
          'SELECT requested_at,confirmed_at,verified_at FROM personal_deletions WHERE chat_id=? AND generation=? AND user_id=? ORDER BY requested_at',
        )
        .all(chat, generation, user),
    },
    profilingDisabledAt: choice?.disabledAt ?? null,
    reminders:
      chat === user
        ? db
            .prepare(
              'SELECT text,origin_at,due_at,timezone,state,finished_at FROM personal_reminders WHERE chat_id=? AND generation=? ORDER BY id',
            )
            .all(chat, generation)
        : [],
    retainedRights: db
      .prepare('SELECT basis FROM bot_admin_grants WHERE chat_id=? AND user_id=? ORDER BY basis')
      .all(chat, user),
    administrativeRestriction: db
      .prepare('SELECT 1 FROM active_admin_denials WHERE chat_id=? AND user_id=?')
      .get(chat, user)
      ? 'Сохраняется запрет автоматического возврата административных прав.'
      : null,
  };
}
