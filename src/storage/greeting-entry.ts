import type { Database } from 'better-sqlite3';
import type { ConnectionScope, HumanMember, UserId } from '../contracts/index';
import { inQuietHours, readChatControl, type ChatControlState } from './chat-control-store';

export function greetingsAllowed(state: ChatControlState, at: number): boolean {
  return (
    state.greetingEnabledAt !== null &&
    state.enabled &&
    state.mode !== 'silent' &&
    (state.pausedUntil === null || state.pausedUntil <= at) &&
    !inQuietHours(state, at)
  );
}

function admittedEvent(
  db: Database,
  scope: ConnectionScope,
  sourceAt: number,
  now: number,
  sequence?: number,
) {
  const controls = readChatControl(db, scope.chatId);
  return (
    controls.greetingEnabledAt !== null &&
    (sourceAt > controls.greetingEnabledAt ||
      (sourceAt === controls.greetingEnabledAt &&
        (controls.greetingEnabledFrom === null ||
          (sequence !== undefined && sequence > controls.greetingEnabledFrom)))) &&
    sourceAt <= now &&
    greetingsAllowed(controls, now)
  );
}

export function rememberGreetingCandidate(
  db: Database,
  scope: ConnectionScope,
  user: UserId,
  sourceAt: number,
  now: number,
  sequence?: number,
) {
  if (!admittedEvent(db, scope, sourceAt, now, sequence)) return;
  db.prepare(
    `INSERT INTO greeting_candidates(chat_id,generation,user_id,source_at,source_sequence) VALUES(?,?,?,?,?)
    ON CONFLICT(chat_id,generation,user_id)
    DO UPDATE SET source_at=excluded.source_at,source_sequence=excluded.source_sequence
    WHERE (excluded.source_at,coalesce(excluded.source_sequence,0)) >
      (source_at,coalesce(source_sequence,0))`,
  ).run(scope.chatId, scope.generation, user, sourceAt, sequence ?? null);
}

export function recordGreetingEntry(
  db: Database,
  scope: ConnectionScope,
  user: UserId,
  returning: boolean,
  sourceAt: number,
  now: number,
  sequence?: number,
) {
  db.prepare('DELETE FROM greeting_candidates WHERE chat_id=? AND generation=? AND user_id=?').run(
    scope.chatId,
    scope.generation,
    user,
  );
  if (!admittedEvent(db, scope, sourceAt, now, sequence)) return;
  const open = db
    .prepare(
      `SELECT id FROM greeting_windows
    WHERE chat_id=? AND generation=? AND state='waiting' AND due_at>? AND opened_at<=?
    ORDER BY due_at DESC LIMIT 1`,
    )
    .get(scope.chatId, scope.generation, now, now) as { id: number } | undefined;
  const window =
    open?.id ??
    Number(
      db
        .prepare(
          `INSERT INTO greeting_windows
    (chat_id,generation,opened_at,due_at,state) VALUES(?,?,?,?,'waiting')`,
        )
        .run(scope.chatId, scope.generation, now, now + 30_000).lastInsertRowid,
    );
  db.prepare(
    'INSERT INTO greeting_members(window_id,user_id,confirmed_at,was_returning) VALUES(?,?,?,?) ON CONFLICT DO NOTHING',
  ).run(window, user, now, Number(returning));
}

export function forgetGreetingEntry(db: Database, scope: ConnectionScope, user: UserId) {
  db.prepare('DELETE FROM greeting_candidates WHERE chat_id=? AND generation=? AND user_id=?').run(
    scope.chatId,
    scope.generation,
    user,
  );
  db.prepare(
    `DELETE FROM greeting_members WHERE user_id=? AND window_id IN (
    SELECT id FROM greeting_windows WHERE chat_id=? AND generation=? AND state='waiting'
  )`,
  ).run(user, scope.chatId, scope.generation);
}

export function confirmGreetingCandidates(
  db: Database,
  scope: ConnectionScope,
  members: readonly HumanMember[],
  startedAt: number,
  now: number,
) {
  const present = new Set<UserId>(members.map(({ userId }) => userId));
  const pending = db
    .prepare(
      `SELECT c.user_id AS user, c.source_at AS sourceAt,c.source_sequence AS sequence,p.status
    FROM greeting_candidates c LEFT JOIN chat_participants p USING(chat_id,user_id)
    WHERE c.chat_id=? AND c.generation=? AND c.source_at<=?
    ORDER BY c.source_at,c.user_id`,
    )
    .all(scope.chatId, scope.generation, startedAt) as {
    user: UserId;
    sourceAt: number;
    sequence: number | null;
    status: string | null;
  }[];
  for (const { user, sourceAt, sequence, status } of pending) {
    if (present.has(user) && status !== 'present')
      recordGreetingEntry(
        db,
        scope,
        user,
        hasPriorDeparture(status),
        sourceAt,
        now,
        sequence ?? undefined,
      );
  }
  db.prepare(
    'DELETE FROM greeting_candidates WHERE chat_id=? AND generation=? AND source_at<=?',
  ).run(scope.chatId, scope.generation, startedAt);
  db.prepare(
    `DELETE FROM greeting_members WHERE window_id IN (
    SELECT id FROM greeting_windows WHERE chat_id=? AND generation=? AND state='waiting'
  ) AND user_id NOT IN (SELECT value FROM json_each(?))`,
  ).run(scope.chatId, scope.generation, JSON.stringify([...present]));
}

export function hasPriorDeparture(status: string | null | undefined): boolean {
  return status === 'left' || status === 'removed' || status === 'absent';
}
