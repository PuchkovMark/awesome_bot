import type { Database } from 'better-sqlite3';
import { reconcileGroupReplyAssessments } from './group-reply-gate-store';
import { matchingColumns } from './database-restore';

function reconcileReminders(staged: Database, newer: Database) {
  const reminderColumns = matchingColumns(staged, newer, 'personal_reminders');
  const partColumns = matchingColumns(staged, newer, 'personal_reminder_parts');
  const find = newer
    .prepare(
      `SELECT ${reminderColumns.join(',')} FROM personal_reminders WHERE id=? AND chat_id=? AND generation=?`,
    )
    .raw();
  const parts = newer
    .prepare(`SELECT ${partColumns.join(',')} FROM personal_reminder_parts WHERE reminder_id=?`)
    .raw();
  const insert = staged.prepare(
    `INSERT INTO personal_reminders(${reminderColumns.join(',')})
     VALUES (${reminderColumns.map(() => '?').join(',')})`,
  );
  const insertPart = staged.prepare(
    `INSERT INTO personal_reminder_parts(${partColumns.join(',')})
     VALUES (${partColumns.map(() => '?').join(',')})`,
  );
  const remove = staged.prepare('DELETE FROM personal_reminders WHERE id=?');
  for (const saved of staged
    .prepare('SELECT id,chat_id,generation FROM personal_reminders')
    .all() as { id: number; chat_id: string; generation: number }[]) {
    const current = find.get(saved.id, saved.chat_id, saved.generation) as unknown[] | undefined;
    remove.run(saved.id);
    if (!current) continue;
    insert.run(...current);
    for (const part of parts.iterate(saved.id) as Iterable<unknown[]>) insertPart.run(...part);
  }
}

function reconcileInvitationAuthors(staged: Database, newer: Database) {
  const current = newer
    .prepare("SELECT 1 FROM sqlite_schema WHERE name='questionnaire_invitation_parts'")
    .get()
    ? newer.prepare(`SELECT m.invitation_attempt AS attempt
      FROM questionnaire_invitation_parts p JOIN greeting_windows w ON w.id=p.window_id
      JOIN greeting_members m ON m.window_id=w.id
      WHERE (p.send_id,p.receipt,w.chat_id,w.generation,m.user_id,m.invitation_participation)=
        (@sendId,@receipt,@chat,@generation,@user,@participation) AND p.state='delivered'`)
    : undefined;
  const update = staged.prepare(`UPDATE greeting_members SET invitation_attempt=@attempt
    WHERE window_id=@id AND user_id=@user`);
  for (const saved of staged
    .prepare(
      `SELECT w.id,w.chat_id AS chat,w.generation,p.send_id AS sendId,
    p.receipt,m.user_id AS user,m.invitation_participation AS participation
    FROM questionnaire_invitation_parts p JOIN greeting_windows w ON w.id=p.window_id
    JOIN greeting_members m ON m.window_id=w.id
    WHERE p.stage='questions' AND p.state='delivered' AND m.invitation_participation IS NOT NULL`,
    )
    .all() as object[]) {
    const live = current?.get(saved) as { attempt: string | null } | undefined;
    update.run({ ...saved, attempt: live ? live.attempt : 'restored' });
  }
}

// Copy only proven, unstarted work. Never restart a publication from an older delivery receipt.
export function reconcileRestoredWork(staged: Database, newer: Database, now: number) {
  const waiting = newer
    .prepare(
      `SELECT j.id,j.chat_id,j.generation,j.message_id,m.platform_message_id
    FROM queue_jobs j JOIN personal_visible_messages m ON m.id=j.message_id
    LEFT JOIN history_retention_boundaries b USING(chat_id,generation)
    WHERE j.state='queued' AND j.expires_at>@now AND m.id>coalesce(b.cleared_through,0)
      AND m.timestamp>coalesce(b.expired_through,-1)
      AND NOT EXISTS(SELECT 1 FROM response_traces t WHERE t.job_id=j.id)
      AND NOT EXISTS(SELECT 1 FROM chat_metrics_publications p WHERE p.job_id=j.id AND (p.confirmed=1 OR p.finished=1))`,
    )
    .raw();
  staged.exec(
    'CREATE TEMP TABLE restore_waiting(id INTEGER PRIMARY KEY,chat_id TEXT,generation INTEGER,message_id INTEGER,platform_message_id TEXT)',
  );
  const remember = staged.prepare('INSERT INTO restore_waiting VALUES(?,?,?,?,?)');
  for (const row of waiting.iterate({ now }) as Iterable<unknown[]>) remember.run(...row);
  staged
    .prepare(
      `UPDATE queue_jobs AS j SET state='terminal',outcome='interrupted',owner=NULL
    WHERE state='running' OR (state='queued' AND (expires_at<=? OR NOT EXISTS(
      SELECT 1 FROM restore_waiting w JOIN personal_visible_messages m ON m.id=w.message_id
      WHERE w.id=j.id AND w.chat_id=j.chat_id AND w.generation=j.generation AND w.message_id=j.message_id
      AND w.platform_message_id=m.platform_message_id)))`,
    )
    .run(now);
  staged.exec(`DROP TABLE temp.restore_waiting;
    DELETE FROM greeting_candidates;
    UPDATE greeting_windows SET state='skipped' WHERE state='waiting';
    UPDATE greeting_windows SET state='unknown' WHERE state='dispatching';
    UPDATE greeting_windows SET invitation_state='skipped' WHERE invitation_state='waiting';
    UPDATE greeting_windows SET invitation_state='unknown' WHERE invitation_state='dispatching';
    UPDATE questionnaire_invitation_parts SET state='unknown',next_check_at=NULL WHERE state IN ('sending','unknown');
    DELETE FROM autonomous_questions;
    UPDATE history_clear_requests SET state='invalidated' WHERE state='pending';`);
  reconcileReminders(staged, newer);
  reconcileInvitationAuthors(staged, newer);
  reconcileGroupReplyAssessments(staged, newer);
}
