import type { Database } from 'better-sqlite3';
import type { ChatId, ConnectionScope, Timestamp, UserId } from '../contracts/index';
import type { Connection } from './connection';
import type { LifecycleBackend } from './lifecycle-store';
import type { ResponseMode, Storage } from './types';
import { compositeId, requireInput, timestamp } from './validation';

export interface ControlMessageEvent {
  readonly sourceChatId: ChatId;
  readonly messageId: number;
  readonly timestamp: Timestamp;
}

export interface ChatControlState {
  readonly enabled: boolean;
  readonly mode: ResponseMode;
  readonly timezone: string;
  readonly pausedUntil: number | null;
  readonly nextParticipantPause: number | null;
  readonly autonomousDisabled: boolean;
  readonly responseRevision: number;
  readonly greetingEnabledAt: number | null;
  readonly greetingEnabledFrom: number | null;
  readonly invitationEnabledAt: number | null;
  readonly invitationEnabledFrom: number | null;
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
    k.greeting_enabled_at AS greetingEnabledAt,k.greeting_enabled_from AS greetingEnabledFrom,
    k.invitation_enabled_at AS invitationEnabledAt,k.invitation_enabled_from AS invitationEnabledFrom,k.quiet_start AS quietStart,k.quiet_end AS quietEnd
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

export function writeWelcomeSetting(
  db: Database,
  chatId: ChatId,
  setting: 'greeting' | 'invitation',
  enabled: boolean,
  now: number,
  sequence?: number,
) {
  timestamp(now);
  requireInput(sequence === undefined || (Number.isSafeInteger(sequence) && sequence > 0));
  const at = setting + '_enabled_at';
  const from = setting + '_enabled_from';
  db.prepare(
    `INSERT INTO chat_controls(chat_id,generation,${at},${from})
    SELECT chat_id,generation,?,? FROM chat_connections WHERE chat_id=?
    ON CONFLICT(chat_id,generation) DO UPDATE SET ${at}=
      CASE WHEN excluded.${at} IS NULL THEN NULL
      ELSE coalesce(chat_controls.${at},excluded.${at}) END,
      ${from}=CASE WHEN excluded.${at} IS NULL THEN NULL
      WHEN chat_controls.${at} IS NULL THEN excluded.${from}
      ELSE chat_controls.${from} END`,
  ).run(
    enabled ? Math.floor(now / 1000) * 1000 : null,
    enabled ? (sequence ?? null) : null,
    chatId,
  );
  if (enabled) return;
  const cancelled = setting === 'invitation' ? 'invitation<>0' : 'invitation=2';
  db.prepare(`UPDATE greeting_candidates SET invitation=0 WHERE chat_id=? AND ${cancelled}`).run(
    chatId,
  );
  db.prepare(
    `UPDATE greeting_members SET invitation=0 WHERE ${cancelled} AND window_id IN
    (SELECT id FROM greeting_windows WHERE chat_id=? AND invitation_state='waiting')`,
  ).run(chatId);
  if (setting === 'greeting') {
    db.prepare('UPDATE greeting_candidates SET greet=0 WHERE chat_id=?').run(chatId);
    db.prepare(
      `UPDATE greeting_members SET greet=0 WHERE window_id IN
      (SELECT id FROM greeting_windows WHERE chat_id=? AND state='waiting')`,
    ).run(chatId);
    db.prepare(
      "UPDATE greeting_windows SET state='skipped' WHERE chat_id=? AND state='waiting'",
    ).run(chatId);
  } else {
    db.prepare(
      `UPDATE greeting_windows SET invitation_state='skipped'
      WHERE chat_id=? AND invitation_state='waiting'`,
    ).run(chatId);
  }
  db.prepare('DELETE FROM greeting_candidates WHERE chat_id=? AND greet=0 AND invitation=0').run(
    chatId,
  );
}

export function writeQuietHours(db: Database, chatId: ChatId, hours: QuietHours | null) {
  if (hours)
    requireInput(
      [hours.start, hours.end].every(
        (minute) => Number.isInteger(minute) && minute >= 0 && minute < 1440,
      ) && hours.start !== hours.end,
    );
  db.prepare(
    `INSERT INTO chat_controls(chat_id,generation,quiet_start,quiet_end,initiative_control_revision)
    SELECT chat_id,generation,?,?,1 FROM chat_connections WHERE chat_id=?
    ON CONFLICT(chat_id,generation) DO UPDATE SET quiet_start=excluded.quiet_start,quiet_end=excluded.quiet_end,
      initiative_control_revision=initiative_control_revision+1
    WHERE quiet_start IS NOT excluded.quiet_start OR quiet_end IS NOT excluded.quiet_end`,
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
    `INSERT INTO chat_controls(chat_id,generation,paused_until,next_participant_pause,autonomous_disabled,initiative_control_revision)
    SELECT chat_id,generation,?,?,?,1 FROM chat_connections WHERE chat_id=?
    ON CONFLICT(chat_id,generation) DO UPDATE SET paused_until=excluded.paused_until,
      next_participant_pause=excluded.next_participant_pause,autonomous_disabled=excluded.autonomous_disabled,
      initiative_control_revision=initiative_control_revision+
        (paused_until IS NOT excluded.paused_until OR autonomous_disabled IS NOT excluded.autonomous_disabled)`,
  ).run(pause.pausedUntil, pause.nextParticipantPause, Number(pause.autonomousDisabled), chatId);
}

export function claimControlMessage(
  db: Database,
  chatId: ChatId,
  actorId: UserId,
  event: ControlMessageEvent,
): boolean {
  const { sourceChatId, messageId, timestamp: eventAt } = event;
  compositeId(sourceChatId);
  requireInput(Number.isSafeInteger(messageId) && messageId > 0);
  timestamp(eventAt);
  return (
    db
      .prepare(
        `INSERT INTO chat_control_commands(chat_id,generation,actor_id,message_id,source_chat_id)
        SELECT target.chat_id,target.generation,@actorId,@messageId,@sourceChatId
        FROM chat_connections AS target
        WHERE target.chat_id=@chatId AND NOT EXISTS (
          SELECT 1 FROM chat_control_commands AS legacy
          WHERE legacy.chat_id=target.chat_id AND legacy.generation=target.generation
            AND legacy.actor_id=@actorId AND legacy.message_id=@messageId
            AND legacy.source_chat_id IS NULL AND @eventAt < legacy.legacy_before
        )
        ON CONFLICT DO NOTHING`,
      )
      .run({ chatId, actorId, sourceChatId, messageId, eventAt }).changes === 1
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
