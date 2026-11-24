import type { Database } from 'better-sqlite3';
import type { ConnectionScope, UserId } from '../contracts/index';
import { historyBounds } from './history-retention-store';
import { departureGraceMs, readDeparture } from './participant-departures';
import { questionnaireFieldPrefix } from './questionnaire-types';
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
  const departure = readDeparture(db, scope, user);
  const expired =
    departure?.returnedAt === null &&
    departure.departedAt !== null &&
    departure.departedAt <= now - departureGraceMs;
  const visible =
    (!choice || now - choice.disabledAt < 7 * 86_400_000) &&
    !departure?.needsVerification &&
    !expired;
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
            `SELECT coalesce(q.question,f.field_key) AS field_key,value,source_kind,reliability,
      coalesce((SELECT v.visibility FROM profile_facts v
        WHERE (v.chat_id,v.generation,v.user_id,v.field_key)=(q.chat_id,q.generation,q.user_id,q.field_key)
          AND v.change_kind='visibility'
        ORDER BY v.source_at DESC,v.event_key DESC,v.id LIMIT 1),f.visibility) AS visibility,
      created_at,updated_at,source_at,r.rejected_at,
      change_kind,CASE WHEN change_kind<>'set' AND interest_key<>'' THEN interest_key END AS interest,
      CASE WHEN f.source_user_id=f.user_id AND EXISTS(
        SELECT 1 FROM personal_visible_messages m
        WHERE m.chat_id=f.chat_id AND m.user_id=f.user_id AND m.platform_message_id=f.source_message_id
          AND m.id>? AND m.timestamp>?
      ) THEN source_message_id END AS own_source_message
      FROM profile_facts f LEFT JOIN profile_fact_rejections r ON r.fact_id=f.id
      LEFT JOIN questionnaire_answer_facts q
        ON (q.chat_id,q.generation,q.user_id,q.field_key)=(f.chat_id,f.generation,f.user_id,f.field_key)
      WHERE f.chat_id=? AND f.user_id=? AND (f.generation=? OR f.generation IS NULL)
       AND (source_kind<>'inferred' OR f.generation IS NULL OR EXISTS(
        SELECT 1 FROM personal_visible_messages m WHERE m.chat_id=f.chat_id
        AND m.platform_message_id=f.source_message_id AND m.id>? AND m.timestamp>?
       ))
       AND (f.field_key NOT GLOB '${questionnaireFieldPrefix}*' OR f.id=(
        SELECT s.id FROM profile_facts s
        WHERE (s.chat_id,s.generation,s.user_id,s.field_key)=(q.chat_id,q.generation,q.user_id,q.field_key)
          AND s.source_kind='self' AND s.change_kind='set'
        ORDER BY s.source_at DESC,s.event_key DESC,s.id LIMIT 1))
      ORDER BY f.id`,
          )
          .all(
            bounds.clearedThrough,
            bounds.expiredThrough,
            chat,
            user,
            generation,
            bounds.clearedThrough,
            bounds.expiredThrough,
          )
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
    questionnaire: visible ? questionnaireExport(db, scope, user, now) : null,
    serviceRecords: {
      greetingEntries: db
        .prepare(
          `SELECT g.confirmed_at,w.due_at,w.state
        FROM greeting_members g JOIN greeting_windows w ON w.id=g.window_id
        WHERE w.chat_id=? AND w.generation=? AND g.user_id=? ORDER BY g.confirmed_at,w.id`,
        )
        .all(chat, generation, user),
      questionnairePrompts: db
        .prepare(
          `SELECT shown_revision FROM questionnaire_editor_prompts
        WHERE chat_id=? AND generation=? AND actor_id=? ORDER BY message_id`,
        )
        .all(chat, generation, user),
      passportPrompts: db
        .prepare(
          `SELECT section,action,revision,expires_at
        FROM chat_passport_prompts WHERE chat_id=? AND generation=? AND actor_id=? AND expires_at>?
        ORDER BY expires_at,message_id`,
        )
        .all(chat, generation, user, now),
      invitationEntries: db
        .prepare(
          `SELECT g.confirmed_at,w.due_at,w.invitation_state AS state
        FROM greeting_members g JOIN greeting_windows w ON w.id=g.window_id
        WHERE w.chat_id=? AND w.generation=? AND g.user_id=? AND (g.invitation<>0 OR g.invited=1)
        ORDER BY g.confirmed_at,w.id`,
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

function questionnaireExport(db: Database, scope: ConnectionScope, user: UserId, now: number) {
  const row = db
    .prepare(
      'SELECT state,template,answers,shown_at FROM questionnaire_progress WHERE chat_id=? AND generation=? AND user_id=?',
    )
    .get(scope.chatId, scope.generation, user) as
    | { state: string; template: string; answers: string | null; shown_at: number | null }
    | undefined;
  if (!row) return null;
  const template = JSON.parse(
    row.template,
  ) as import('../contracts/questionnaire').QuestionnaireRevision;
  const answers = JSON.parse(row.answers ?? '{}') as Record<string, string>;
  const linked = db
    .prepare(
      `SELECT q.position, (SELECT f.value FROM profile_facts f
      WHERE (f.chat_id,f.generation,f.user_id,f.field_key)=(q.chat_id,q.generation,q.user_id,q.field_key)
        AND f.source_kind='self' AND f.change_kind='set'
      ORDER BY f.source_at DESC,f.event_key DESC,f.id LIMIT 1) AS value
    FROM questionnaire_answer_facts q WHERE q.chat_id=? AND q.generation=? AND q.user_id=?`,
    )
    .all(scope.chatId, scope.generation, user) as { position: number; value: string }[];
  for (const { position, value } of linked) answers[position] = value;
  const access = db
    .prepare(
      `SELECT a.prompt_delivered_at AS deliveredAt,a.decision
      FROM questionnaire_access a JOIN questionnaire_progress q USING(chat_id,generation,user_id,attempt)
      WHERE a.chat_id=? AND a.generation=? AND a.user_id=?`,
    )
    .get(scope.chatId, scope.generation, user) as
    { deliveredAt: number | null; decision: string | null } | undefined;
  const presentation = db
    .prepare(
      `SELECT state,confirmed_parts AS confirmedParts
    FROM questionnaire_presentations WHERE chat_id=? AND generation=? AND user_id=?`,
    )
    .get(scope.chatId, scope.generation, user) as
    { state: string; confirmedParts: number } | undefined;
  return {
    state:
      row.state === 'active' && row.shown_at !== null && now - row.shown_at >= 3_600_000
        ? 'paused'
        : row.state,
    revision: template.ref.revision,
    shownAt: row.shown_at,
    ...(access ? { access } : {}),
    ...(presentation ? { presentation } : {}),
    questions: template.questions.map((q) => ({
      question: q.text,
      answer: answers[q.position] ?? null,
    })),
  };
}
