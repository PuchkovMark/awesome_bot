import type { Database } from 'better-sqlite3';
import type { ChatId } from '../contracts/index';
import { applyHistoryRetention, historyBounds } from './history-retention-store';
import { reconcileStagedPersonalData } from './personal-data-restore';
import { reconcileConnections } from './database-restore';
import { reconcileRestoredWork } from './restore-work';

function reconcileHistory(staged: Database, newer: Database, now: number, duration: number) {
  applyHistoryRetention(staged, duration, now);
  const setBounds = staged.prepare(`INSERT INTO history_retention_boundaries VALUES(?,?,?,?)
    ON CONFLICT(chat_id,generation) DO UPDATE SET cleared_through=max(cleared_through,excluded.cleared_through),
    expired_through=max(expired_through,excluded.expired_through)`);
  const deleted = newer
    .prepare(
      'SELECT platform_message_id FROM history_deleted_inputs WHERE chat_id=? AND generation=?',
    )
    .pluck();
  const remember = staged.prepare('INSERT OR IGNORE INTO history_deleted_inputs VALUES(?,?,?)');
  const savedSequence =
    (staged.prepare("SELECT seq FROM sqlite_sequence WHERE name='messages'").pluck().get() as
      number | undefined) ?? 0;
  const laterInputs = newer
    .prepare("SELECT platform_message_id FROM messages WHERE chat_id=? AND id>? AND role='user'")
    .pluck();
  for (const scope of staged.prepare('SELECT chat_id,generation FROM chat_connections').all() as {
    chat_id: ChatId;
    generation: number;
  }[]) {
    const bounds = historyBounds(newer, scope.chat_id, now);
    setBounds.run(
      scope.chat_id,
      scope.generation,
      bounds.clearedThrough,
      Math.max(-1, now - duration, bounds.expiredThrough),
    );
    for (const id of deleted.iterate(scope.chat_id, scope.generation))
      remember.run(scope.chat_id, scope.generation, id);
    for (const id of laterInputs.iterate(scope.chat_id, savedSequence))
      remember.run(scope.chat_id, scope.generation, id);
  }
  // Resolve dependencies before a cascading deletion erases the edges linking them to the source.
  staged.exec(`CREATE TEMP TABLE restore_removed(id INTEGER PRIMARY KEY);
    WITH RECURSIVE removed(id) AS (
      SELECT m.id FROM messages m JOIN history_retention_boundaries b USING(chat_id)
      WHERE m.id<=b.cleared_through OR m.timestamp<=b.expired_through
        OR EXISTS(SELECT 1 FROM history_deleted_inputs d WHERE d.chat_id=m.chat_id AND d.platform_message_id=m.platform_message_id)
      UNION SELECT a.answer_id FROM personal_answer_sources a JOIN removed r ON r.id=a.source_id
    ) INSERT INTO restore_removed SELECT id FROM removed;
    INSERT OR IGNORE INTO history_deleted_inputs
      SELECT m.chat_id,b.generation,m.platform_message_id FROM messages m JOIN history_retention_boundaries b USING(chat_id)
      WHERE m.id<=b.cleared_through AND m.role='user';
    DELETE FROM queue_jobs WHERE id IN (SELECT t.job_id FROM response_traces t
      WHERE EXISTS (SELECT 1 FROM json_each(t.payload,'$.context.messageIds') j JOIN restore_removed r ON r.id=j.value));
    DELETE FROM profile_facts WHERE source_kind<>'self' AND (chat_id,source_message_id) IN
      (SELECT chat_id,platform_message_id FROM messages JOIN restore_removed USING(id));
    UPDATE questionnaire_progress SET answers=NULL WHERE source_id IN (SELECT id FROM restore_removed);
    DELETE FROM messages WHERE id IN (SELECT id FROM restore_removed);
    DROP TABLE temp.restore_removed`);
  // Old confirmations cannot affect messages created after restoring this database.
  const sequences = newer.prepare('SELECT name,seq FROM sqlite_sequence').all() as {
    name: string;
    seq: number;
  }[];
  const raise = staged.prepare('UPDATE sqlite_sequence SET seq=max(seq,?) WHERE name=?');
  const start = staged.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)');
  for (const { name, seq } of sequences) if (!raise.run(seq, name).changes) start.run(name, seq);
  staged.exec(
    `UPDATE sqlite_sequence SET seq=max(seq,coalesce((SELECT max(cleared_through) FROM history_retention_boundaries),0)) WHERE name='messages'`,
  );
}

function restoreProfileEdits(staged: Database, newer: Database) {
  const columns =
    'chat_id,user_id,field_key,value,source_kind,source_user_id,source_message_id,source_note,reliability,visibility,created_at,updated_at,generation,source_at,event_key,interest_key,change_kind';
  const edits = newer.prepare(`SELECT ${columns} FROM profile_facts WHERE source_kind='self'
    AND (change_kind IN ('visibility','withdraw') OR event_key GLOB '2:profile:*') ORDER BY id`);
  const insert = staged.prepare(`INSERT OR IGNORE INTO profile_facts(${columns})
    SELECT ${columns
      .split(',')
      .map((name) => '@' + name)
      .join(',')}
    WHERE EXISTS(SELECT 1 FROM profile_facts f JOIN chat_connections c USING(chat_id)
      WHERE c.generation=@generation AND f.chat_id=@chat_id AND f.user_id=@user_id AND f.field_key=@field_key)`);
  for (const row of edits.iterate() as Iterable<object>) insert.run(row);
}

export function reconcileRestore(staged: Database, newer: Database, now: number, duration: number) {
  return newer
    .transaction(() => {
      const result = staged
        .transaction(() => {
          const access = reconcileConnections(staged, newer);
          restoreProfileEdits(staged, newer);
          reconcileHistory(staged, newer, now, duration);
          return access;
        })
        .immediate();
      reconcileStagedPersonalData(staged, newer, now);
      staged.transaction(() => reconcileRestoredWork(staged, newer, now)).immediate();
      return result;
    })
    .deferred();
}
