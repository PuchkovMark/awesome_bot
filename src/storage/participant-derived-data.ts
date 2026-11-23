import type { Database } from 'better-sqlite3';
import type { ConnectionScope, UserId } from '../contracts/index';

type ChatGeneration = Pick<ConnectionScope, 'chatId' | 'generation'>;
const subject = 'chat_id=@chatId AND generation=@generation AND user_id=@user';

/** Выводы, использовавшие профиль, и ответы, производные от них. */
export function hideDepartedAnswersSql(selection: string) {
  return `WITH RECURSIVE selected AS (
    SELECT chat_id,generation,user_id FROM participant_departures WHERE ${selection}
  ), affected(chat_id,generation,user_id,answer_id,disputed) AS (
    SELECT s.chat_id,s.generation,s.user_id,t.answer_id,0 FROM selected s
    JOIN tool_answer_subjects t USING(user_id) JOIN messages m ON m.id=t.answer_id
    WHERE m.chat_id=s.chat_id AND m.role='assistant'
    UNION
    SELECT s.chat_id,s.generation,s.user_id,w.message_id,0 FROM selected s
    JOIN greeting_members g USING(user_id) JOIN greeting_windows w ON w.id=g.window_id
    JOIN messages m ON m.id=w.message_id AND m.chat_id=s.chat_id AND m.role='assistant'
    WHERE (w.chat_id,w.generation)=(s.chat_id,s.generation) AND g.greet=1
    UNION
    SELECT s.chat_id,s.generation,s.user_id,w.invitation_message_id,0 FROM selected s
    JOIN greeting_members g USING(user_id) JOIN greeting_windows w ON w.id=g.window_id
    JOIN messages m ON m.id=w.invitation_message_id AND m.chat_id=s.chat_id AND m.role='assistant'
    WHERE (w.chat_id,w.generation)=(s.chat_id,s.generation) AND g.invited=1
    UNION
    SELECT s.chat_id,s.generation,s.user_id,m.id,1 FROM selected s
    JOIN participant_profiles p ON (p.chat_id,p.user_id)=(s.chat_id,s.user_id)
    JOIN messages m ON m.chat_id=s.chat_id AND m.timestamp>=p.created_at
    WHERE m.role='assistant' AND m.purpose='conversation'
      AND NOT EXISTS(SELECT 1 FROM personal_answer_sources a WHERE a.answer_id=m.id)
    UNION
    SELECT s.chat_id,s.generation,s.user_id,m.id,1 FROM selected s
    JOIN address_preferences p ON (p.chat_id,p.generation,p.user_id)=(s.chat_id,s.generation,s.user_id)
    JOIN messages m ON m.chat_id=s.chat_id AND m.timestamp>=p.changed_at
    JOIN messages origin ON (origin.chat_id,origin.platform_message_id)=(m.chat_id,m.reply_to_message_id)
    WHERE m.role='assistant' AND m.purpose='conversation' AND origin.role='user' AND origin.user_id=s.user_id
      AND p.form IS NOT NULL AND instr(m.text,p.form)>0
    UNION
    SELECT a.chat_id,a.generation,a.user_id,s.answer_id,a.disputed FROM affected a
    JOIN personal_answer_sources s ON s.source_id=a.answer_id JOIN messages m ON m.id=s.answer_id
    WHERE m.chat_id=a.chat_id AND m.role='assistant'
  )
  INSERT INTO departed_profile_answers(chat_id,generation,user_id,answer_id,disputed)
    SELECT chat_id,generation,user_id,answer_id,min(disputed) FROM affected
    GROUP BY chat_id,generation,user_id,answer_id
  ON CONFLICT(chat_id,generation,user_id,answer_id) DO UPDATE SET
    disputed=min(departed_profile_answers.disputed,excluded.disputed)`;
}

export function hideDepartedAnswers(db: Database, scope: ChatGeneration, user: UserId) {
  db.prepare(hideDepartedAnswersSql(subject)).run({ ...scope, user });
}

export function releaseDepartedAnswers(db: Database, scope: ChatGeneration, user: UserId) {
  db.prepare(`DELETE FROM departed_profile_answers WHERE ${subject} AND retired=0`).run({
    ...scope,
    user,
  });
}

function eraseAnswers(
  db: Database,
  scope: ChatGeneration,
  selection: string,
  user?: UserId,
  answer?: number,
) {
  const args = { ...scope, user: user ?? null, answer: answer ?? null };
  const messages = `SELECT id,platform_message_id FROM messages WHERE chat_id=@chatId
    AND role='assistant' AND id IN (${selection})`;
  db.prepare(
    `INSERT OR IGNORE INTO history_deleted_inputs(chat_id,generation,platform_message_id)
    SELECT @chatId,@generation,platform_message_id FROM (${messages})`,
  ).run(args);
  db.prepare(
    `UPDATE messages SET reply_to_message_id=NULL WHERE chat_id=@chatId
    AND reply_to_message_id IN (SELECT platform_message_id FROM (${messages}))`,
  ).run(args);
  // Окно может одновременно хранить результат независимого приглашения.
  db.prepare(
    `UPDATE greeting_windows SET message_id=NULL WHERE chat_id=@chatId AND generation=@generation
    AND message_id IN (SELECT id FROM (${messages}))`,
  ).run(args);
  db.prepare(`DELETE FROM messages WHERE id IN (SELECT id FROM (${messages}))`).run(args);
}

export function eraseDepartedAnswers(db: Database, scope: ChatGeneration, user: UserId) {
  hideDepartedAnswers(db, scope, user);
  eraseAnswers(
    db,
    scope,
    `SELECT answer_id FROM departed_profile_answers WHERE ${subject} AND disputed=0`,
    user,
  );
  db.prepare(`UPDATE departed_profile_answers SET retired=1 WHERE ${subject}`).run({
    ...scope,
    user,
  });
}

/** Квитанция может быть принята после ухода, даже если отправка уже была разрешена. */
export function recordProfileAnswer(
  db: Database,
  scope: ChatGeneration,
  answer: number,
  subjects: readonly UserId[],
  sources: readonly number[] = [],
) {
  if (!subjects.length && !sources.length) return;
  const args = {
    ...scope,
    answer,
    subjects: JSON.stringify(subjects),
    sources: JSON.stringify(sources),
  };
  if (subjects.length)
    db.prepare(
      'INSERT OR IGNORE INTO tool_answer_subjects SELECT @answer,value FROM json_each(@subjects)',
    ).run(args);
  const changed = db
    .prepare(
      `INSERT OR IGNORE INTO departed_profile_answers(chat_id,generation,user_id,answer_id,disputed,retired)
    SELECT chat_id,generation,user_id,@answer,0,0 FROM participant_departures
    WHERE chat_id=@chatId AND generation=@generation AND (returned_at IS NULL OR needs_verification=1)
      AND user_id IN (SELECT value FROM json_each(@subjects))
    UNION ALL SELECT chat_id,generation,user_id,@answer,min(disputed),max(retired) FROM departed_profile_answers
    WHERE chat_id=@chatId AND generation=@generation AND answer_id IN (SELECT value FROM json_each(@sources))
    GROUP BY chat_id,generation,user_id`,
    )
    .run(args);
  if (
    changed.changes &&
    db
      .prepare(
        `SELECT 1 FROM departed_profile_answers h JOIN participant_departures d USING(chat_id,generation,user_id)
      WHERE h.answer_id=@answer AND h.disputed=0 AND d.purged_at IS NOT NULL`,
      )
      .get(args)
  )
    eraseAnswers(db, scope, 'SELECT @answer', undefined, answer);
}
