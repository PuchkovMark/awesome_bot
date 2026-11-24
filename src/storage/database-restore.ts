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
  const tables = [
    'bot_admin_grants',
    'bot_admin_revocations',
    'bot_admin_revocation_audit',
    'bot_admin_controls',
    'personal_retained_denials',
    'admin_observations',
    'admin_presence',
    'admin_recovery_operations',
    'chat_controls',
    'chat_control_commands',
    'disclosure_publications',
    'chat_token_budgets',
    'token_budget_attempts',
  ];
  // Remove dependent audit rows before their revocation, then restore parents first.
  for (const table of [...tables].reverse())
    staged.prepare('DELETE FROM ' + table + ' WHERE chat_id=?').run(chat);
  for (const table of tables) copyRows(staged, newer, table, chat);
  const state = newer
    .prepare(
      'SELECT revision,state,pause_reason,creator_id,inviter_id,creator_applied,inviter_applied FROM chat_connections WHERE chat_id=?',
    )
    .get(chat) as object;
  staged
    .prepare(
      'UPDATE chat_connections SET revision=@revision,state=@state,pause_reason=@pause_reason,creator_id=@creator_id,inviter_id=@inviter_id,creator_applied=@creator_applied,inviter_applied=@inviter_applied WHERE chat_id=@chat',
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
  staged.exec('UPDATE queue_lease SET token=NULL,expires_at=0,safety_ms=0');
  const scopes = staged.prepare('SELECT chat_id,generation FROM chat_connections').all() as Scope[];
  const active = newer.prepare(
    "SELECT 1 FROM chat_connections WHERE chat_id=? AND generation=? AND state='active'",
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
  let admitted = 0;
  for (const scope of scopes) {
    if (!active.get(scope.chat_id, scope.generation)) {
      removeStoredChat(staged, scope.chat_id);
      continue;
    }
    restorePermissions(staged, newer, scope);
    admitted++;
  }
  staged
    .prepare('UPDATE lifecycle_clock SET value=max(value,?) WHERE singleton=1')
    .run(latestClock);
  const closed = scopes.length - admitted;
  return { access: closed === 0 ? 'full' : admitted ? 'partial' : 'denied', admitted, closed };
}
