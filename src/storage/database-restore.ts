import type { Database } from 'better-sqlite3';
import type { ChatId } from '../contracts/index';
import { BackupFailure, snapshotMetadata } from './database-backup';
import { removeStoredChat } from './lifecycle-store';

type Scope = { chat_id: ChatId; generation: number };
export type RestoreAdmission = {
  access: 'full' | 'partial' | 'denied';
  admitted: number;
  closed: number;
};

// Both databases have the application's known schema. Table names below are fixed by the caller.
function copyRows(staged: Database, newer: Database, table: string, chat?: ChatId) {
  const select = newer
    .prepare('SELECT * FROM ' + table + (chat === undefined ? '' : ' WHERE chat_id=?'))
    .raw();
  const values = select
    .columns()
    .map(() => '?')
    .join(',');
  const insert = staged.prepare(
    'INSERT ' +
      (chat === undefined ? 'OR IGNORE ' : '') +
      'INTO ' +
      table +
      ' VALUES (' +
      values +
      ')',
  );
  for (const row of select.iterate(...(chat === undefined ? [] : [chat])) as Iterable<unknown[]>)
    insert.run(...row);
}

function restorePermissions(staged: Database, newer: Database, scope: Scope) {
  const chat = scope.chat_id;
  if (!staged.prepare('SELECT 1 FROM chats WHERE chat_id=?').get(chat))
    copyRows(staged, newer, 'chats', chat);
  const tables = [
    'connection_source_boundaries',
    'connection_observations',
    'unverified_admin_grants',
    'bot_admin_grants',
    'bot_admin_revocations',
    'bot_admin_revocation_audit',
    'bot_admin_controls',
    'personal_retained_denials',
    'address_preferences',
    'admin_observations',
    'admin_presence',
    'admin_recovery_operations',
    'chat_controls',
    'chat_control_commands',
    'disclosure_publications',
    'chat_token_budgets',
    'token_budget_attempts',
    'request_quota_admissions',
    'response_rate_clock',
    'response_rate_publications',
    'mention_flood_state',
    'mention_flood_inputs',
  ];
  // Remove dependent audit rows before their revocation, then restore parents first.
  for (const table of [...tables].reverse())
    staged.prepare('DELETE FROM ' + table + ' WHERE chat_id=?').run(chat);
  for (const table of tables) copyRows(staged, newer, table, chat);
  const state = newer
    .prepare(
      'SELECT revision,state,pause_reason,established,creator_id,inviter_id,creator_applied,inviter_applied FROM chat_connections WHERE chat_id=?',
    )
    .get(chat) as object;
  staged
    .prepare(
      'UPDATE chat_connections SET revision=@revision,state=@state,pause_reason=@pause_reason,established=@established,creator_id=@creator_id,inviter_id=@inviter_id,creator_applied=@creator_applied,inviter_applied=@inviter_applied WHERE chat_id=@chat',
    )
    .run({ ...state, chat });
  const settings = newer
    .prepare('SELECT enabled,response_mode FROM chats WHERE chat_id=?')
    .get(chat) as object | undefined;
  if (settings)
    staged
      .prepare('UPDATE chats SET enabled=@enabled,response_mode=@response_mode WHERE chat_id=@chat')
      .run({ ...settings, chat });
}

export function reconcileConnections(staged: Database, newer: Database): RestoreAdmission {
  if (
    !newer.readonly ||
    !newer.inTransaction ||
    !staged.inTransaction ||
    snapshotMetadata(newer) ||
    staged.name === newer.name
  )
    throw new BackupFailure('untrusted_source');
  staged
    .prepare("UPDATE paused_reset_requests SET state='closed' WHERE state IN ('pending','ready')")
    .run();
  staged.exec(`UPDATE queue_lease SET token=NULL,expires_at=0,safety_ms=0;
    CREATE TEMP TABLE IF NOT EXISTS restore_inventory AS SELECT count(*) AS total FROM chat_connections`);
  const scopes = staged.prepare('SELECT chat_id,generation FROM chat_connections').all() as Scope[];
  const active = newer.prepare(
    `SELECT 1 FROM chat_connections c LEFT JOIN chats s USING(chat_id) WHERE chat_id=? AND generation=?
      AND (state='active' OR (established=1 AND (s.enabled=0 OR pause_reason IN ('startup','observation_lost','verification_uncertain'))))`,
  );
  const latestClock = newer
    .prepare('SELECT value FROM lifecycle_clock WHERE singleton=1')
    .pluck()
    .get() as number;
  if (
    latestClock <
    (staged.prepare('SELECT value FROM lifecycle_clock WHERE singleton=1').pluck().get() as number)
  )
    throw new BackupFailure('untrusted_source');
  copyRows(staged, newer, 'disclosure_versions');
  staged.exec('DELETE FROM llm_recovery');
  copyRows(staged, newer, 'llm_recovery');
  let admitted = 0;
  for (const scope of scopes) {
    if (!active.get(scope.chat_id, scope.generation)) {
      removeStoredChat(staged, scope.chat_id);
      continue;
    }
    restorePermissions(staged, newer, scope);
    admitted++;
  }
  // Более позднее выключение лички должно пережить даже снимок, сделанный до её первого входа.
  const disabled = newer
    .prepare(
      `SELECT c.chat_id,c.generation,c.revision FROM chat_connections c
    JOIN chats s USING(chat_id) WHERE c.established=1 AND s.enabled=0`,
    )
    .all() as (Scope & { revision: number })[];
  for (const row of disabled) {
    if (staged.prepare('SELECT 1 FROM chat_connections WHERE chat_id=?').get(row.chat_id)) continue;
    staged
      .prepare(
        `INSERT INTO chat_connections(chat_id,generation,revision,state,pause_reason,established)
      VALUES(@chat_id,@generation,@revision,'uncertain','startup',1)`,
      )
      .run(row);
    copyRows(staged, newer, 'chats', row.chat_id);
    copyRows(staged, newer, 'chat_controls', row.chat_id);
    copyRows(staged, newer, 'chat_control_commands', row.chat_id);
    copyRows(staged, newer, 'chat_metrics_collection', row.chat_id);
  }
  staged.prepare('UPDATE lifecycle_clock SET value=? WHERE singleton=1').run(latestClock);
  const total = staged.prepare('SELECT total FROM temp.restore_inventory').pluck().get() as number;
  const closed = total - admitted;
  return { access: closed === 0 ? 'full' : admitted ? 'partial' : 'denied', admitted, closed };
}
