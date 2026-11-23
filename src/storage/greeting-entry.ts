import type { Database } from 'better-sqlite3';
import type { ConnectionScope, HumanMember, UserId } from '../contracts/index';
import { inQuietHours, readChatControl, type ChatControlState } from './chat-control-store';

function welcomeAllowed(state: ChatControlState, at: number): boolean {
  return (
    state.enabled &&
    state.mode !== 'silent' &&
    (state.pausedUntil === null || state.pausedUntil <= at) &&
    !inQuietHours(state, at)
  );
}

export function greetingsAllowed(state: ChatControlState, at: number): boolean {
  return state.greetingEnabledAt !== null && welcomeAllowed(state, at);
}

export function invitationsAllowed(state: ChatControlState, at: number): boolean {
  return state.invitationEnabledAt !== null && welcomeAllowed(state, at);
}

type Entry = {
  readonly greet: number;
  // 1 — отдельная отправка, 2 — только после подтверждённого приветствия.
  readonly invitation: number;
};

function admittedEntry(
  db: Database,
  scope: ConnectionScope,
  sourceAt: number,
  now: number,
  sequence?: number,
): Entry {
  const controls = readChatControl(db, scope.chatId);
  const after = (at: number | null, from: number | null) =>
    at !== null &&
    (sourceAt > at ||
      (sourceAt === at && (from === null || (sequence !== undefined && sequence > from))));
  const allowed = sourceAt <= now && welcomeAllowed(controls, now);
  const greet = allowed && after(controls.greetingEnabledAt, controls.greetingEnabledFrom);
  const invite = allowed && after(controls.invitationEnabledAt, controls.invitationEnabledFrom);
  return { greet: Number(greet), invitation: invite ? (greet ? 2 : 1) : 0 };
}

const removeCandidate =
  'DELETE FROM greeting_candidates WHERE chat_id=? AND generation=? AND user_id=?';

export function rememberGreetingCandidate(
  db: Database,
  scope: ConnectionScope,
  user: UserId,
  sourceAt: number,
  now: number,
  sequence?: number,
) {
  const { greet, invitation } = admittedEntry(db, scope, sourceAt, now, sequence);
  if (!greet && !invitation) return;
  db.prepare(
    `INSERT INTO greeting_candidates(chat_id,generation,user_id,source_at,source_sequence,greet,invitation)
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(chat_id,generation,user_id)
    DO UPDATE SET source_at=excluded.source_at,source_sequence=excluded.source_sequence,
    greet=excluded.greet,invitation=excluded.invitation
    WHERE (excluded.source_at,coalesce(excluded.source_sequence,0)) >
      (source_at,coalesce(source_sequence,0))`,
  ).run(scope.chatId, scope.generation, user, sourceAt, sequence ?? null, greet, invitation);
}

export function recordGreetingEntry(
  db: Database,
  scope: ConnectionScope,
  user: UserId,
  returning: boolean,
  sourceAt: number,
  now: number,
  sequence?: number,
  candidate?: Entry,
) {
  db.prepare(removeCandidate).run(scope.chatId, scope.generation, user);
  const allowed = admittedEntry(db, scope, sourceAt, now, sequence);
  const greet = candidate ? Number(!!(candidate.greet && allowed.greet)) : allowed.greet;
  const invitation = !candidate
    ? allowed.invitation
    : allowed.invitation && (candidate.invitation === 1 || (candidate.invitation === 2 && greet))
      ? candidate.invitation
      : 0;
  if (!greet && !invitation) return;
  const open = db
    .prepare(
      `SELECT id FROM greeting_windows
    WHERE chat_id=? AND generation=? AND due_at>? AND opened_at<=?
    ORDER BY due_at DESC LIMIT 1`,
    )
    .get(scope.chatId, scope.generation, now, now) as { id: number } | undefined;
  const window =
    open?.id ??
    Number(
      db
        .prepare(
          `INSERT INTO greeting_windows
    (chat_id,generation,opened_at,due_at,state) VALUES(?,?,?,?,'skipped')`,
        )
        .run(scope.chatId, scope.generation, now, now + 30_000).lastInsertRowid,
    );
  db.prepare(
    `INSERT INTO greeting_members(window_id,user_id,confirmed_at,was_returning,greet,invitation)
     VALUES(?,?,?,?,?,?) ON CONFLICT(window_id,user_id) DO UPDATE SET
     confirmed_at=excluded.confirmed_at,was_returning=excluded.was_returning,
     greet=excluded.greet,invitation=excluded.invitation
     WHERE greeting_members.greet=0 AND greeting_members.invitation=0`,
  ).run(window, user, now, Number(returning), greet, invitation);
  db.prepare(
    `UPDATE greeting_windows SET
      state=CASE WHEN ?=1 AND state='skipped' THEN 'waiting' ELSE state END,
      invitation_state=CASE WHEN ?>0 AND invitation_state='skipped' THEN 'waiting' ELSE invitation_state END
     WHERE id=?`,
  ).run(greet, invitation, window);
}

function removePendingMembers(
  db: Database,
  scope: ConnectionScope,
  excluded: readonly UserId[],
  inverse = false,
) {
  const selected = `window_id IN (SELECT id FROM greeting_windows WHERE chat_id=? AND generation=?
    AND (state='waiting' OR invitation_state='waiting'))
    AND user_id ${inverse ? 'NOT IN' : 'IN'} (SELECT value FROM json_each(?))`;
  const args = [scope.chatId, scope.generation, JSON.stringify(excluded)];
  db.prepare(
    `DELETE FROM greeting_members WHERE ${selected} AND window_id IN
     (SELECT id FROM greeting_windows WHERE state IN ('waiting','skipped')
     AND invitation_state IN ('waiting','skipped'))`,
  ).run(...args);
  db.prepare(
    `UPDATE greeting_members SET
       greet=CASE WHEN window_id IN (SELECT id FROM greeting_windows WHERE state='waiting') THEN 0 ELSE greet END,
       invitation=CASE WHEN window_id IN (SELECT id FROM greeting_windows WHERE invitation_state='waiting') THEN 0 ELSE invitation END
     WHERE ${selected}`,
  ).run(...args);
}

export function forgetGreetingEntry(db: Database, scope: ConnectionScope, user: UserId) {
  db.prepare(removeCandidate).run(scope.chatId, scope.generation, user);
  removePendingMembers(db, scope, [user]);
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
      `SELECT c.user_id AS user, c.source_at AS sourceAt,c.source_sequence AS sequence,p.status,c.greet,c.invitation
    FROM greeting_candidates c LEFT JOIN chat_participants p USING(chat_id,user_id)
    WHERE c.chat_id=? AND c.generation=? AND c.source_at<=?
    ORDER BY c.source_at,c.user_id`,
    )
    .all(scope.chatId, scope.generation, startedAt) as (Entry & {
    user: UserId;
    sourceAt: number;
    sequence: number | null;
    status: string | null;
  })[];
  for (const candidate of pending) {
    const { user, sourceAt, sequence, status } = candidate;
    if (present.has(user) && status !== 'present')
      recordGreetingEntry(
        db,
        scope,
        user,
        hasPriorDeparture(status),
        sourceAt,
        now,
        sequence ?? undefined,
        candidate,
      );
  }
  db.prepare(
    'DELETE FROM greeting_candidates WHERE chat_id=? AND generation=? AND source_at<=?',
  ).run(scope.chatId, scope.generation, startedAt);
  removePendingMembers(db, scope, [...present], true);
}

export function hasPriorDeparture(status: string | null | undefined): boolean {
  return status === 'left' || status === 'removed' || status === 'absent';
}
