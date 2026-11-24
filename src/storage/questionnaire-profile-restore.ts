import type { Database } from 'better-sqlite3';

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
  const latestBinding = newer.prepare(
    `SELECT fact_id FROM questionnaire_answer_facts WHERE ${subject} AND field_key=@field_key`,
  );
  const latestEdits = newer.prepare(`SELECT * FROM profile_facts WHERE ${field} AND id<>@fact_id
    AND source_kind='self' AND source_user_id=@user_id AND event_key GLOB '2:profile:*'
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
