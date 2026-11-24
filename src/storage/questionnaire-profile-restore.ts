import type { Database } from 'better-sqlite3';
import { eraseQuestionnaireAttempt } from './questionnaire-management-store';

const subject =
  'chat_id=@chat_id AND generation=@generation AND user_id=@user_id AND attempt=@attempt';
const field =
  'chat_id=@chat_id AND generation=@generation AND user_id=@user_id AND field_key=@field_key';

interface Attempt {
  readonly chat_id: string;
  readonly generation: number;
  readonly user_id: string;
  readonly attempt: string;
}
interface Binding extends Attempt {
  readonly field_key: string;
  readonly fact_id: number;
}

export function reconcileStagedQuestionnaires(staged: Database, newer: Database) {
  if (
    !newer
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='questionnaire_answer_facts'",
      )
      .get()
  )
    return;
  const rememberReceipt = staged.prepare(`INSERT OR IGNORE INTO questionnaire_management_prompts
    (chat_id,generation,receipt,first_position,last_position,expires_at)
    SELECT chat_id,generation,@receipt,0,0,0 FROM chat_connections WHERE chat_id=@chat_id AND generation=@generation`);
  function ignoreReceipts(sql: string) {
    for (const row of newer.prepare(sql).iterate() as Iterable<object>) rememberReceipt.run(row);
  }
  if (
    newer.prepare("SELECT 1 FROM sqlite_schema WHERE name='questionnaire_management_prompts'").get()
  )
    ignoreReceipts('SELECT chat_id,generation,receipt FROM questionnaire_management_prompts');
  // Снимок может предшествовать доставке последнего вопроса старой версии.
  if (newer.prepare("SELECT 1 FROM sqlite_schema WHERE name='questionnaire_access'").get())
    ignoreReceipts(
      'SELECT chat_id,generation,prompt_message_id AS receipt FROM questionnaire_access WHERE prompt_message_id IS NOT NULL',
    );
  else if (
    newer
      .prepare(
        "SELECT 1 FROM pragma_table_info('questionnaire_progress') WHERE name='legacy_access_prompt_id'",
      )
      .get()
  )
    ignoreReceipts(
      'SELECT chat_id,generation,legacy_access_prompt_id AS receipt FROM questionnaire_progress WHERE legacy_access_prompt_id IS NOT NULL',
    );
  if (newer.prepare("SELECT 1 FROM sqlite_schema WHERE name='questionnaire_removals'").get()) {
    const copy = staged.prepare(`INSERT OR IGNORE INTO questionnaire_removals
      SELECT chat_id,generation,@user_id,@attempt,@removed_at,@event_id FROM chat_connections WHERE chat_id=@chat_id AND generation=@generation`);
    const previous = staged.prepare(`SELECT 1 FROM questionnaire_progress WHERE ${subject}`);
    const replacement =
      newer.prepare(`SELECT * FROM questionnaire_progress WHERE chat_id=@chat_id AND generation=@generation
      AND user_id=@user_id AND attempt<>@attempt AND state='completed'`);
    const adopt =
      staged.prepare(`INSERT INTO questionnaire_progress(chat_id,generation,user_id,attempt,presentation,template,
      state,shown_at,response_message_id,legacy_access_prompt_id) VALUES(@chat_id,@generation,@user_id,@attempt,@presentation,
      @template,'completed',@shown_at,@response_message_id,@legacy_access_prompt_id)`);
    for (const row of newer
      .prepare('SELECT * FROM questionnaire_removals')
      .iterate() as Iterable<Attempt>) {
      copy.run(row);
      const replacing = previous.get(row) && replacement.get(row);
      eraseQuestionnaireAttempt(staged, row.chat_id, row.generation, row.user_id, row.attempt);
      if (replacing) adopt.run(replacing);
    }
  }
  const latestBinding = newer.prepare(
    `SELECT fact_id FROM questionnaire_answer_facts WHERE ${subject} AND field_key=@field_key`,
  );
  const latestEdits = newer.prepare(`SELECT * FROM profile_facts WHERE ${field} AND id<>@fact_id
    AND source_kind='self' AND source_user_id=@user_id AND (event_key GLOB '2:profile:*' OR event_key GLOB '2:questionnaire:*')
    ORDER BY id`);
  const clearEdits = staged.prepare(`DELETE FROM profile_facts WHERE ${field} AND id<>@fact_id`);
  const clearOriginal = staged.prepare('DELETE FROM profile_facts WHERE id=?');
  const copyEdit = staged.prepare(`INSERT INTO profile_facts(
    chat_id,user_id,field_key,value,source_kind,source_user_id,source_message_id,source_note,
    reliability,visibility,created_at,updated_at,generation,source_at,event_key,interest_key,change_kind
  ) VALUES(@chat_id,@user_id,@field_key,@value,'self',@user_id,NULL,NULL,
    @reliability,@visibility,@created_at,@updated_at,@generation,@source_at,@event_key,'',@change_kind)`);
  const updateProfile =
    staged.prepare(`UPDATE participant_profiles SET updated_at=max(updated_at,@updated_at)
    WHERE chat_id=@chat_id AND user_id=@user_id`);
  // Пропуск мог получить первый ответ уже после создания копии.
  const additions =
    newer.prepare(`SELECT b.*,f.value,f.source_message_id,f.visibility,f.created_at,f.updated_at,f.source_at,f.event_key
    FROM questionnaire_answer_facts b JOIN profile_facts f ON f.id=b.fact_id
    WHERE b.chat_id=@chat_id AND b.generation=@generation AND b.user_id=@user_id AND b.attempt=@attempt`);
  const known = staged.prepare(
    `SELECT 1 FROM questionnaire_answer_facts WHERE ${subject} AND field_key=@field_key`,
  );
  const original =
    staged.prepare(`INSERT INTO profile_facts(chat_id,user_id,field_key,value,source_kind,
    source_user_id,source_message_id,reliability,visibility,created_at,updated_at,generation,source_at,event_key)
    VALUES(@chat_id,@user_id,@field_key,@value,'self',@user_id,@source_message_id,'confirmed',@visibility,
      @created_at,@updated_at,@generation,@source_at,@event_key)`);
  const bind =
    staged.prepare(`INSERT INTO questionnaire_answer_facts VALUES(@chat_id,@generation,@user_id,@attempt,
    @template_key,@template_revision,@position,@question,@field_key,@fact_id)`);
  for (const attempt of staged
    .prepare("SELECT * FROM questionnaire_progress WHERE state='completed'")
    .all() as Attempt[]) {
    for (const row of additions.iterate(attempt) as Iterable<Binding>) {
      if (known.get(row)) continue;
      staged
        .prepare(
          `INSERT INTO participant_profiles(chat_id,user_id,created_at,updated_at)
        VALUES(@chat_id,@user_id,@created_at,@updated_at) ON CONFLICT DO NOTHING`,
        )
        .run(row);
      bind.run({ ...row, fact_id: original.run(row).lastInsertRowid });
      updateProfile.run(row);
    }
  }
  for (const saved of staged
    .prepare('SELECT * FROM questionnaire_answer_facts')
    .all() as Binding[]) {
    clearEdits.run(saved);
    const current = latestBinding.get(saved) as Pick<Binding, 'fact_id'> | undefined;
    if (!current) {
      clearOriginal.run(saved.fact_id);
      continue;
    }
    for (const edit of latestEdits.iterate({ ...saved, ...current }) as Iterable<object>) {
      copyEdit.run(edit);
      updateProfile.run(edit);
    }
  }

  if (
    newer
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='questionnaire_presentations'",
      )
      .get()
  ) {
    const copy = staged.prepare(`INSERT INTO questionnaire_presentations
      SELECT chat_id,generation,user_id,attempt,@prompt_message_id,@event_id,
        CASE WHEN @state='sending' THEN 'unknown' ELSE @state END,@confirmed_parts
      FROM questionnaire_progress WHERE state='completed' AND ${subject}
      ON CONFLICT(chat_id,generation,user_id,attempt) DO UPDATE SET
        prompt_message_id=excluded.prompt_message_id,event_id=excluded.event_id,
        state=excluded.state,confirmed_parts=excluded.confirmed_parts
      WHERE coalesce(excluded.event_id,0)>=coalesce(questionnaire_presentations.event_id,0)`);
    for (const row of newer
      .prepare('SELECT * FROM questionnaire_presentations')
      .iterate() as Iterable<object>)
      copy.run(row);
  }
}
