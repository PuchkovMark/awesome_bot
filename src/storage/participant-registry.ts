import { historyBounds, historySourcesVisible } from './history-retention-store';
import {
  confirmGreetingCandidates,
  forgetGreetingEntry,
  hasPriorDeparture,
  recordGreetingEntry,
  rememberGreetingCandidate,
} from './greeting-entry';
import type { Database } from 'better-sqlite3';
import type { ConnectionScope, HumanMember, MembershipEvent, UserId } from '../contracts/index';
import type { LifecycleBackend } from './lifecycle-store';
import type { ParticipantRecord } from './participant-types';
import type { Storage } from './types';
import type { Connection } from './connection';
import { createChatStore } from './chats';
import { compositeId, requireInput, timestamp } from './validation';

interface SyncRow {
  readonly revision: number;
  readonly lastAttemptAt: number | null;
  readonly lastAttemptComplete: 0 | 1 | null;
  readonly lastCompleteStartedAt: number | null;
  readonly lastCompleteAt: number | null;
  readonly needsSync: 0 | 1;
}

export function participantSync(db: Database, scope: ConnectionScope): SyncRow {
  return (
    (db
      .prepare(
        `SELECT revision,last_attempt_at AS lastAttemptAt,last_attempt_complete AS lastAttemptComplete,
      last_complete_started_at AS lastCompleteStartedAt,last_complete_at AS lastCompleteAt,needs_sync AS needsSync
      FROM participant_sync WHERE chat_id=? AND generation=?`,
      )
      .get(scope.chatId, scope.generation) as SyncRow | undefined) ?? {
      revision: 0,
      lastAttemptAt: null,
      lastAttemptComplete: null,
      lastCompleteStartedAt: null,
      lastCompleteAt: null,
      needsSync: 1,
    }
  );
}

function participantErased(db: Database, scope: ConnectionScope, userId: UserId) {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM personal_deletions WHERE chat_id=? AND generation=? AND user_id=?
    AND confirmed_at IS NOT NULL LIMIT 1`,
      )
      .get(scope.chatId, scope.generation, userId),
  );
}

export function noteParticipantMessage(
  db: Database,
  scope: ConnectionScope,
  userId: UserId,
  at: number,
) {
  if (participantErased(db, scope, userId)) return;
  db.prepare(
    `INSERT INTO chat_participants(chat_id,user_id,role,status,last_seen_at)
    VALUES(?,?,'unknown','unknown',?)
    ON CONFLICT(chat_id,user_id) DO UPDATE SET last_seen_at=excluded.last_seen_at
    WHERE last_seen_at IS NULL OR last_seen_at<excluded.last_seen_at`,
  ).run(scope.chatId, userId, at);
}

function invalidateSnapshot(db: Database, scope: ConnectionScope) {
  db.prepare(
    `INSERT INTO participant_sync(chat_id,generation,revision,needs_sync)
    VALUES(?,?,1,1) ON CONFLICT(chat_id,generation)
    DO UPDATE SET revision=revision+1, needs_sync=1`,
  ).run(scope.chatId, scope.generation);
}

function updateStatus(
  db: Database,
  scope: ConnectionScope,
  user: UserId,
  status: 'present' | 'left' | 'removed',
  at: number,
) {
  db.prepare(
    `INSERT INTO chat_participants(chat_id,user_id,joined_at,role,status,status_observed_at)
    VALUES(?,?,?,'unknown',?,?) ON CONFLICT(chat_id,user_id) DO UPDATE SET
    joined_at=CASE WHEN excluded.status='present' THEN excluded.joined_at ELSE joined_at END,
    role=CASE WHEN excluded.status='present' AND status<>'present' THEN 'unknown' ELSE role END,
    role_observed_at=CASE WHEN excluded.status='present' AND status<>'present' THEN NULL ELSE role_observed_at END,
    status=excluded.status,status_observed_at=excluded.status_observed_at`,
  ).run(scope.chatId, user, status === 'present' ? at : null, status, at);
}

export function applyParticipantSnapshot(
  db: Database,
  scope: ConnectionScope,
  members: readonly HumanMember[],
  at: number,
  startedAt = at,
) {
  const erased = new Set(
    db
      .prepare(
        'SELECT distinct user_id FROM personal_deletions WHERE chat_id=? AND generation=? AND confirmed_at IS NOT NULL',
      )
      .pluck()
      .all(scope.chatId, scope.generation),
  );
  const visible = members.filter(({ userId }) => !erased.has(userId));
  confirmGreetingCandidates(db, scope, visible, startedAt, at);
  const data = JSON.stringify(visible);
  db.prepare(
    `INSERT INTO chat_participants(chat_id,user_id,role,role_observed_at,status,status_observed_at)
    SELECT ?,json_extract(value,'$.userId'),json_extract(value,'$.role'),
      CASE WHEN json_extract(value,'$.role')='unknown' THEN NULL ELSE ? END,'present',?
    FROM json_each(?) WHERE true
    ON CONFLICT(chat_id,user_id) DO UPDATE SET
    joined_at=CASE WHEN status='present' THEN joined_at ELSE NULL END,
    role=CASE WHEN excluded.role<>'unknown' OR status<>'present' THEN excluded.role ELSE role END,
    role_observed_at=CASE WHEN excluded.role<>'unknown' OR status<>'present'
      THEN excluded.role_observed_at ELSE role_observed_at END,
    status=excluded.status,status_observed_at=excluded.status_observed_at`,
  ).run(scope.chatId, at, at, data);
  db.prepare(
    `UPDATE chat_participants SET status='absent',status_observed_at=?
    WHERE chat_id=? AND status NOT IN ('left','removed')
    AND user_id NOT IN (SELECT json_extract(value,'$.userId') FROM json_each(?))`,
  ).run(at, scope.chatId, data);
}

export function createParticipantRegistry(connection: Connection, lifecycle: LifecycleBackend) {
  const chats = createChatStore(connection);
  return {
    observe(scope: ConnectionScope, event: MembershipEvent, identity?: string, greeting = false) {
      requireInput(event.chatId === scope.chatId);
      timestamp(event.timestamp);
      if (event.subjectId !== null) compositeId(event.subjectId);
      return lifecycle.transaction(scope, (db) => {
        const key = identity
          ? 'message:' + identity
          : event.eventId
            ? 'event:' + event.eventId
            : null;
        if (
          key &&
          db
            .prepare(`INSERT INTO participant_events VALUES(?,?,?) ON CONFLICT DO NOTHING`)
            .run(scope.chatId, scope.generation, key).changes === 0
        )
          return false;
        const user = event.subjectId;
        if (!user || !key || participantErased(db, scope, user)) {
          invalidateSnapshot(db, scope);
          return true;
        }
        const prior = db
          .prepare(
            'SELECT status,status_observed_at AS at FROM chat_participants WHERE chat_id=? AND user_id=?',
          )
          .get(scope.chatId, user) as
          { status: ParticipantRecord['status']; at: number | null } | undefined;
        const meta = participantSync(db, scope);
        const at = event.timestamp;
        const number = Number(identity);
        const sequence =
          Number.isSafeInteger(number) && number > 0 && String(number) === identity
            ? number
            : undefined;
        const status = event.change === 'joined' ? 'present' : event.change;
        if (
          status === 'invited' ||
          status === 'unknown' ||
          (greeting && status === 'present' && event.actorId !== user)
        ) {
          if (
            greeting &&
            prior?.status !== 'present' &&
            (meta.lastCompleteStartedAt === null || at >= meta.lastCompleteStartedAt) &&
            (prior?.at == null || at > prior.at)
          )
            rememberGreetingCandidate(db, scope, user, at, Date.now(), sequence);
          invalidateSnapshot(db, scope);
          return true;
        }
        if (meta.lastCompleteStartedAt !== null && at < meta.lastCompleteStartedAt) return false;
        if (prior?.at !== null && prior?.at !== undefined && prior.at >= at) {
          const overlapsSnapshot =
            meta.lastCompleteStartedAt !== null &&
            meta.lastCompleteAt !== null &&
            at >= meta.lastCompleteStartedAt &&
            at <= meta.lastCompleteAt &&
            prior.at <= meta.lastCompleteAt;
          if (prior.status !== status && (at === prior.at || overlapsSnapshot)) {
            invalidateSnapshot(db, scope);
            return true;
          }
          return false;
        }
        chats.create(scope.chatId, { enabled: true, responseMode: 'normal', createdAt: at });
        updateStatus(db, scope, user, status, at);
        if (status === 'present') {
          if (greeting && prior?.status !== 'present')
            recordGreetingEntry(
              db,
              scope,
              user,
              hasPriorDeparture(prior?.status),
              at,
              Date.now(),
              sequence,
            );
        } else forgetGreetingEntry(db, scope, user);
        invalidateSnapshot(db, scope);
        return true;
      });
    },
    sourcesVisible(scope: ConnectionScope, ids: readonly number[]) {
      return lifecycle.transaction(scope, (db) => historySourcesVisible(db, scope.chatId, ids));
    },
    publicMembers(scope: ConnectionScope, cutoff: number) {
      return lifecycle.transaction(scope, (db) => {
        const bounds = historyBounds(db, scope.chatId);
        const meta = participantSync(db, scope);
        // Имя берётся только из ещё видимой записи текущей беседы.
        const rows = db
          .prepare(
            `WITH names AS (
          SELECT id,user_id,author_name,row_number() OVER (PARTITION BY user_id ORDER BY id DESC) AS position
          FROM personal_visible_messages WHERE chat_id=? AND id>? AND timestamp>? AND id<=? AND role='user'
        ) SELECT p.user_id AS user,p.status,n.author_name AS name,n.id AS nameId FROM chat_participants p
        LEFT JOIN names n ON n.user_id=p.user_id AND n.position=1 WHERE p.chat_id=?
        AND NOT EXISTS (SELECT 1 FROM personal_deletions d WHERE d.chat_id=p.chat_id AND d.generation=? AND d.user_id=p.user_id AND d.confirmed_at IS NOT NULL)`,
          )
          .all(
            scope.chatId,
            bounds.clearedThrough,
            bounds.expiredThrough,
            cutoff,
            scope.chatId,
            scope.generation,
          ) as { user: UserId; status: string; name: string | null; nameId: number | null }[];
        return { complete: meta.lastAttemptComplete === 1 && meta.needsSync === 0, rows };
      });
    },
    lastAttemptIncomplete(scope: ConnectionScope) {
      return lifecycle.transaction(
        scope,
        (db) => participantSync(db, scope).lastAttemptComplete === 0,
      );
    },
    read(scope: ConnectionScope) {
      return lifecycle.transaction(scope, (db) => {
        const meta = participantSync(db, scope);
        const participants = db
          .prepare(
            `SELECT chat_id AS chatId,user_id AS userId,joined_at AS joinedAt,role,
          role_observed_at AS roleObservedAt,status,status_observed_at AS statusObservedAt,
          last_seen_at AS lastSeenAt FROM chat_participants WHERE chat_id=? ORDER BY user_id`,
          )
          .all(scope.chatId) as ParticipantRecord[];
        return {
          ...meta,
          lastAttemptComplete:
            meta.lastAttemptComplete === null ? null : meta.lastAttemptComplete === 1,
          needsSync: meta.needsSync === 1,
          participants,
        };
      });
    },
  };
}

const registries = new WeakMap<Storage, ReturnType<typeof createParticipantRegistry>>();
export function registerParticipantRegistry(
  storage: Storage,
  registry: ReturnType<typeof createParticipantRegistry>,
) {
  registries.set(storage, registry);
}

export function participantRegistryStore(storage: Storage) {
  const registry = registries.get(storage);
  if (!registry) throw new TypeError('Participant registry: unavailable');
  return registry;
}
