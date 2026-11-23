import type { Database } from 'better-sqlite3';
import type { ChatId, ConnectionScope, UserId } from '../contracts/index';
import type { Connection } from './connection';
import type { LifecycleBackend } from './lifecycle-store';
import type { ResponseMode, Storage } from './types';
import { requireInput, timestamp } from './validation';

export interface ChatControlState {
  readonly enabled: boolean;
  readonly mode: ResponseMode;
  readonly timezone: string;
  readonly pausedUntil: number | null;
  readonly nextParticipantPause: number | null;
  readonly autonomousDisabled: boolean;
  readonly responseRevision: number;
  readonly quietHours: QuietHours | null;
}
export interface QuietHours {
  readonly start: number;
  readonly end: number;
}

export type ChatPause = Pick<
  ChatControlState,
  'pausedUntil' | 'nextParticipantPause' | 'autonomousDisabled'
>;

export function readChatControl(db: Database, chatId: ChatId): ChatControlState {
  const row = db
    .prepare(
      `SELECT coalesce(s.enabled,1) AS enabled,coalesce(s.response_mode,'normal') AS mode,
    coalesce(s.timezone,'Europe/Moscow') AS timezone,k.paused_until AS pausedUntil,k.next_participant_pause AS nextParticipantPause,
    coalesce(k.autonomous_disabled,0) AS autonomousDisabled,coalesce(k.response_revision,0) AS responseRevision,
    k.quiet_start AS quietStart,k.quiet_end AS quietEnd
    FROM chat_connections c LEFT JOIN chats s USING(chat_id) LEFT JOIN chat_controls k USING(chat_id,generation)
    WHERE c.chat_id=?`,
    )
    .get(chatId) as
    | (Omit<ChatControlState, 'enabled' | 'autonomousDisabled' | 'quietHours'> & {
        enabled: number;
        autonomousDisabled: number;
        quietStart: number | null;
        quietEnd: number | null;
      })
    | undefined;
  requireInput(row);
  const { quietStart, quietEnd, ...state } = row;
  return {
    ...state,
    enabled: row.enabled === 1,
    autonomousDisabled: row.autonomousDisabled === 1,
    quietHours:
      quietStart === null || quietEnd === null ? null : { start: quietStart, end: quietEnd },
  };
}

export function writeQuietHours(db: Database, chatId: ChatId, hours: QuietHours | null) {
  if (hours)
    requireInput(
      [hours.start, hours.end].every(
        (minute) => Number.isInteger(minute) && minute >= 0 && minute < 1440,
      ) && hours.start !== hours.end,
    );
  db.prepare(
    `INSERT INTO chat_controls(chat_id,generation,quiet_start,quiet_end)
    SELECT chat_id,generation,?,? FROM chat_connections WHERE chat_id=?
    ON CONFLICT(chat_id,generation) DO UPDATE SET quiet_start=excluded.quiet_start,quiet_end=excluded.quiet_end`,
  ).run(hours?.start ?? null, hours?.end ?? null, chatId);
}

export function inQuietHours(state: ChatControlState, now: number): boolean {
  const hours = state.quietHours;
  if (!hours) return false;
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: state.timezone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const minute =
    Number(time.find(({ type }) => type === 'hour')?.value) * 60 +
    Number(time.find(({ type }) => type === 'minute')?.value);
  return hours.start < hours.end
    ? minute >= hours.start && minute < hours.end
    : minute >= hours.start || minute < hours.end;
}

export function revokeOrdinaryWork(db: Database, chatId: ChatId) {
  const changed = db
    .prepare(
      `INSERT INTO chat_controls(chat_id,generation,response_revision)
    SELECT chat_id,generation,1 FROM chat_connections WHERE chat_id=?
    ON CONFLICT(chat_id,generation) DO UPDATE SET response_revision=response_revision+1`,
    )
    .run(chatId);
  if (!changed.changes) return;
  db.prepare(
    `UPDATE queue_jobs SET state='terminal',outcome='interrupted' WHERE chat_id=? AND state='queued'
    AND route_kind IS NOT NULL AND generation=(SELECT generation FROM chat_connections WHERE chat_id=?)`,
  ).run(chatId, chatId);
}

export function writeChatPause(db: Database, chatId: ChatId, pause: ChatPause) {
  if (pause.pausedUntil !== null) timestamp(pause.pausedUntil);
  if (pause.nextParticipantPause !== null) timestamp(pause.nextParticipantPause);
  db.prepare(
    `INSERT INTO chat_controls(chat_id,generation,paused_until,next_participant_pause,autonomous_disabled)
    SELECT chat_id,generation,?,?,? FROM chat_connections WHERE chat_id=?
    ON CONFLICT(chat_id,generation) DO UPDATE SET paused_until=excluded.paused_until,
      next_participant_pause=excluded.next_participant_pause,autonomous_disabled=excluded.autonomous_disabled`,
  ).run(pause.pausedUntil, pause.nextParticipantPause, Number(pause.autonomousDisabled), chatId);
}

export function claimControlMessage(
  db: Database,
  chatId: ChatId,
  actorId: UserId,
  messageId: number,
): boolean {
  requireInput(Number.isSafeInteger(messageId) && messageId > 0);
  return (
    db
      .prepare(
        `INSERT INTO chat_control_commands(chat_id,generation,actor_id,message_id)
    SELECT chat_id,generation,?,? FROM chat_connections WHERE chat_id=?
    ON CONFLICT DO NOTHING`,
      )
      .run(actorId, messageId, chatId).changes === 1
  );
}

function ordinaryAllowed(state: ChatControlState) {
  return state.enabled && state.mode !== 'silent';
}
export function allowsAutonomousReply(state: ChatControlState, now: number): boolean {
  timestamp(now);
  return (
    state.enabled &&
    state.mode === 'active' &&
    !state.autonomousDisabled &&
    (state.pausedUntil === null || now >= state.pausedUntil) &&
    !inQuietHours(state, now)
  );
}

export function createChatControlStore(connection: Connection, lifecycle: LifecycleBackend) {
  const read = (scope: ConnectionScope) =>
    lifecycle.transaction(scope, (db) => readChatControl(db, scope.chatId));
  return {
    read,
    capture(scope: ConnectionScope) {
      const received = read(scope);
      return () => {
        try {
          const current = read(scope);
          return {
            journal: received.enabled && current.enabled,
            ordinary:
              ordinaryAllowed(received) &&
              ordinaryAllowed(current) &&
              received.responseRevision === current.responseRevision,
          };
        } catch {
          return { journal: false, ordinary: false };
        }
      };
    },
    allowsAutonomous(scope: ConnectionScope, now: number) {
      return allowsAutonomousReply(read(scope), now);
    },
  };
}

const stores = new WeakMap<Storage, ReturnType<typeof createChatControlStore>>();
export function registerChatControl(
  storage: Storage,
  store: ReturnType<typeof createChatControlStore>,
) {
  stores.set(storage, store);
}
export function chatControlStore(storage: Storage) {
  const store = stores.get(storage);
  requireInput(store);
  return store;
}
