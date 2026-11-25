import type { Database } from 'better-sqlite3';
import type { ConnectionScope, UserId } from '../contracts/index';
import type { RecapBounds } from '../core/chat-summaries/recap-period';
import { historySourcesVisible } from './history-retention-store';

export interface RecapReply {
  readonly root: number;
  readonly actor: UserId;
  readonly previous?: number;
  readonly known?: RecapBounds;
}
interface Prompt {
  root: number;
  source: number;
  prompt: number;
  calendar: string | null;
  knownFrom: number | null;
  knownTo: number | null;
}
const fields =
  'root_id AS root,source_id AS source,message_id AS prompt,calendar,known_from AS knownFrom,known_to AS knownTo';
const scopeFilter = 'chat_id=? AND generation=?';
function visible(db: Database, scope: ConnectionScope, row: Prompt) {
  return historySourcesVisible(db, scope.chatId, [...new Set([row.root, row.source, row.prompt])]);
}
export function claimRecapInput(
  db: Database,
  scope: ConnectionScope,
  actor: UserId,
  receipt: string,
  jobId: number,
) {
  const row = db
    .prepare(
      'SELECT ' +
        fields +
        ' FROM recap_clarifications WHERE ' +
        scopeFilter +
        ' AND user_id=? AND receipt=?',
    )
    .get(scope.chatId, scope.generation, actor, receipt) as Prompt | undefined;
  if (!row || !visible(db, scope, row)) return false;
  db.prepare(
    'UPDATE queue_jobs SET recap_prompt_id=? WHERE id=? AND chat_id=? AND generation=?',
  ).run(row.prompt, jobId, scope.chatId, scope.generation);
  return true;
}
export function readRecapInput(db: Database, scope: ConnectionScope, input: number) {
  const prompt = db
    .prepare('SELECT recap_prompt_id FROM queue_jobs WHERE ' + scopeFilter + ' AND message_id=?')
    .pluck()
    .get(scope.chatId, scope.generation, input);
  if (typeof prompt !== 'number') return undefined;
  const row = db
    .prepare(
      'SELECT ' + fields + ' FROM recap_clarifications WHERE ' + scopeFilter + ' AND message_id=?',
    )
    .get(scope.chatId, scope.generation, prompt) as Prompt | undefined;
  if (!row || !visible(db, scope, row)) return 'closed' as const;
  return {
    root: row.root,
    prompt: row.prompt,
    known: {
      ...(row.calendar && {
        calendar: JSON.parse(row.calendar) as NonNullable<RecapBounds['calendar']>,
      }),
      ...(row.knownFrom !== null && { from: row.knownFrom }),
      ...(row.knownTo !== null && { to: row.knownTo }),
    },
  };
}
export function confirmRecapReply(
  db: Database,
  scope: ConnectionScope,
  source: number,
  receipt: string,
  reply: RecapReply,
) {
  const args = [scope.chatId, scope.generation] as const;
  if (reply.previous !== undefined) {
    const consumed = db
      .prepare(
        'DELETE FROM recap_clarifications WHERE ' +
          scopeFilter +
          ' AND user_id=? AND root_id=? AND message_id=?',
      )
      .run(...args, reply.actor, reply.root, reply.previous);
    if (!consumed.changes) return;
  }
  if (!reply.known) return;
  db.prepare(
    `INSERT INTO recap_clarifications(chat_id,generation,receipt,user_id,message_id,root_id,source_id,known_from,known_to,calendar)
    SELECT ?,?,?,?,id,?,?,?,?,? FROM messages WHERE chat_id=? AND platform_message_id=? AND role='assistant'
    ON CONFLICT(chat_id,generation,receipt) DO NOTHING`,
  ).run(
    ...args,
    receipt,
    reply.actor,
    reply.root,
    source,
    reply.known.from ?? null,
    reply.known.to ?? null,
    reply.known.calendar ? JSON.stringify(reply.known.calendar) : null,
    scope.chatId,
    receipt,
  );
}
