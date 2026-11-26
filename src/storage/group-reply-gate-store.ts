import type { Database } from 'better-sqlite3';
import type { ChatId, ConnectionScope, UserId } from '../contracts/index';
import type { GroupReplyAssessment } from '../core/message-router/types';
import { readChatControl } from './chat-control-store';
import { readDisclosureGate } from './chat-disclosure-store';
import type { Connection } from './connection';
import { historySourcesVisible } from './history-retention-store';
import type { LifecycleBackend } from './lifecycle-store';
import type { Storage } from './types';
import { requireInput, timestamp } from './validation';

const lifetimeMs = 120_000;
const maxWaitingPerChat = 2;
const maxWaiting = 32;
const unfinished = "state IN ('waiting','reserved','sent','approved')";
const key = 'message_id=@messageId AND (chat_id,generation)=(@chatId,@generation)';
const columns = `message_id AS messageId,chat_id AS chatId,generation,kind,mode,
  received_at AS receivedAt,expires_at AS expiresAt,revision,control_revision AS controlRevision,
  disclosure_version AS disclosureVersion,glossary_revision AS glossaryRevision,
  reply_author_id AS replyAuthorId,other_address AS otherAddress,forwarded,state,resume_allowed AS resumeAllowed,
  attempt_key AS attemptKey,source_ids AS sourceIds,frontier,outcome,latency_ms AS latencyMs`;

type State = 'waiting' | 'reserved' | 'sent' | 'approved' | 'queued' | 'finished';
export type GateOutcome = 'answer' | 'silence' | 'failed' | 'cancelled' | 'expired' | 'uncertain';

export interface GroupReplyCandidate extends GroupReplyAssessment {
  readonly mode: 'normal' | 'active';
  readonly replyAuthorId?: UserId;
  readonly otherAddress: boolean;
  readonly forwarded: boolean;
}

export interface StoredGroupReplyAssessment {
  readonly messageId: number;
  readonly chatId: ChatId;
  readonly generation: number;
  readonly kind: GroupReplyAssessment['kind'];
  readonly mode: GroupReplyCandidate['mode'];
  readonly receivedAt: number;
  readonly expiresAt: number;
  readonly revision: number;
  readonly controlRevision: number;
  readonly disclosureVersion: number;
  readonly glossaryRevision: number | null;
  readonly replyAuthorId: UserId | null;
  readonly otherAddress: number;
  readonly forwarded: number;
  readonly state: State;
  readonly resumeAllowed: number;
  readonly attemptKey: string | null;
  readonly sourceIds: string | null;
  readonly frontier: number | null;
  readonly outcome: GateOutcome | null;
  readonly latencyMs: number | null;
}

export function rememberGroupReplyAssessment(
  db: Database,
  scope: ConnectionScope,
  messageId: number,
  candidate: GroupReplyCandidate,
  now: number,
  revision: number,
  disclosureVersion: number | null,
) {
  requireInput(db.inTransaction);
  if (disclosureVersion === null) return false;
  timestamp(now + lifetimeMs);
  const depth = db
    .prepare(
      `SELECT count(*) AS total,count(CASE WHEN chat_id=? THEN 1 END) AS local
    FROM group_reply_assessments WHERE ${unfinished} AND expires_at>?`,
    )
    .get(scope.chatId, now) as { total: number; local: number };
  if (depth.local >= maxWaitingPerChat || depth.total >= maxWaiting) return false;
  return (
    db
      .prepare(
        `INSERT INTO group_reply_assessments(
    message_id,chat_id,generation,kind,mode,received_at,expires_at,revision,control_revision,
    disclosure_version,glossary_revision,reply_author_id,other_address,forwarded,state
  ) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,'waiting'
  WHERE EXISTS(SELECT 1 FROM messages WHERE id=? AND chat_id=?
    AND role='user' AND purpose='conversation' AND sender_bot=0)
  ON CONFLICT DO NOTHING`,
      )
      .run(
        messageId,
        scope.chatId,
        scope.generation,
        candidate.kind,
        candidate.mode,
        now,
        now + lifetimeMs,
        revision,
        readChatControl(db, scope.chatId).responseRevision,
        disclosureVersion,
        candidate.glossaryRevision ?? null,
        candidate.replyAuthorId ?? null,
        Number(candidate.otherAddress),
        Number(candidate.forwarded),
        messageId,
        scope.chatId,
      ).changes === 1
  );
}

export function readGroupReplyAssessment(db: Database, scope: ConnectionScope, messageId: number) {
  return db
    .prepare(`SELECT ${columns} FROM group_reply_assessments WHERE ${key}`)
    .get({ ...scope, messageId }) as StoredGroupReplyAssessment | undefined;
}

export function groupReplyAssessmentCurrent(
  db: Database,
  scope: ConnectionScope,
  row: StoredGroupReplyAssessment,
  now: number,
) {
  const chat = db
    .prepare(
      `SELECT c.revision,coalesce(b.message_floor,0) AS floor FROM chat_connections c
    LEFT JOIN connection_source_boundaries b USING(chat_id,generation)
    WHERE c.chat_id=? AND c.generation=? AND c.state='active'`,
    )
    .get(scope.chatId, scope.generation) as { revision: number; floor: number } | undefined;
  const control = readChatControl(db, scope.chatId);
  if (
    !chat ||
    row.chatId !== scope.chatId ||
    row.generation !== scope.generation ||
    (row.revision !== chat.revision && row.resumeAllowed !== 1) ||
    !control.enabled ||
    control.mode !== row.mode ||
    control.responseRevision !== row.controlRevision ||
    readDisclosureGate(db, scope).version !== row.disclosureVersion ||
    row.expiresAt <= now
  )
    return null;
  if (
    row.glossaryRevision !== null &&
    !db
      .prepare(
        `SELECT 1 FROM chat_passport_sections
      WHERE chat_id=? AND generation=? AND section='glossary' AND revision=?`,
      )
      .get(scope.chatId, scope.generation, row.glossaryRevision)
  )
    return null;
  const sources =
    row.sourceIds === null ? [row.messageId] : (JSON.parse(row.sourceIds) as number[]);
  return sources.every((id) => id > chat.floor) &&
    historySourcesVisible(db, scope.chatId, sources, now)
    ? chat
    : null;
}

export function reconcileGroupReplyAssessments(staged: Database, newer: Database) {
  const present = newer
    .prepare("SELECT 1 FROM sqlite_schema WHERE name='group_reply_assessments'")
    .get();
  const live = present
    ? newer.prepare(`SELECT a.state,a.attempt_key AS attemptKey,a.outcome,a.source_ids AS sourceIds,a.frontier
      FROM group_reply_assessments a JOIN messages m ON m.id=a.message_id
      WHERE a.chat_id=@chatId AND a.generation=@generation AND a.message_id=@messageId
        AND m.platform_message_id=@platformId`)
    : undefined;
  const close = staged.prepare(`UPDATE group_reply_assessments SET state='finished',outcome=@outcome
    WHERE ${key} AND ${unfinished}`);
  const rows = staged
    .prepare(
      `SELECT a.message_id AS messageId,a.chat_id AS chatId,a.generation,
    a.state,a.attempt_key AS attemptKey,a.source_ids AS sourceIds,a.frontier,m.platform_message_id AS platformId
    FROM group_reply_assessments a JOIN messages m ON m.id=a.message_id
    WHERE a.state IN ('waiting','reserved','sent','approved')`,
    )
    .all() as (Pick<
    StoredGroupReplyAssessment,
    'messageId' | 'chatId' | 'generation' | 'state' | 'attemptKey' | 'sourceIds' | 'frontier'
  > & { platformId: string })[];
  for (const row of rows) {
    const current = live?.get(row) as
      | Pick<
          StoredGroupReplyAssessment,
          'state' | 'attemptKey' | 'outcome' | 'sourceIds' | 'frontier'
        >
      | undefined;
    if (
      (row.state === 'waiting' &&
        (current?.state === 'waiting' || current?.state === 'reserved')) ||
      (row.state === 'approved' &&
        current?.state === 'approved' &&
        row.attemptKey === current.attemptKey &&
        row.sourceIds === current.sourceIds &&
        row.frontier === current.frontier)
    )
      continue;
    close.run({
      ...row,
      outcome:
        current?.outcome ??
        (current?.state === 'sent' || row.state === 'sent' ? 'uncertain' : 'cancelled'),
    });
  }
}

export function createGroupReplyGateStore(connection: Connection, lifecycle: LifecycleBackend) {
  return {
    recover(platform: string) {
      const prefix = platform + ':';
      connection.run((db) =>
        db
          .transaction(() => {
            const params = { prefix };
            db.prepare(
              `UPDATE group_reply_assessments SET state='finished',outcome='uncertain'
          WHERE state='sent' AND substr(chat_id,1,length(@prefix))=@prefix`,
            ).run(params);
            db.prepare(
              `UPDATE group_reply_assessments SET state='waiting',attempt_key=NULL,source_ids=NULL,frontier=NULL
          WHERE state='reserved' AND substr(chat_id,1,length(@prefix))=@prefix`,
            ).run(params);
            db.prepare(
              `UPDATE group_reply_assessments SET resume_allowed=1
          WHERE state IN ('waiting','approved') AND substr(chat_id,1,length(@prefix))=@prefix`,
            ).run(params);
          })
          .immediate(),
      );
    },
    next(platform: string, now: number, excluded: readonly number[] = []) {
      const prefix = platform + ':';
      return connection.run((db) =>
        db
          .transaction(() => {
            db.prepare(
              `UPDATE group_reply_assessments SET state='finished',outcome='expired'
          WHERE state IN ('waiting','approved') AND expires_at<=@now AND substr(chat_id,1,length(@prefix))=@prefix`,
            ).run({ prefix, now });
            return db
              .prepare(
                `SELECT ${columns} FROM group_reply_assessments a
          WHERE state IN ('approved','waiting') AND expires_at>@now AND substr(chat_id,1,length(@prefix))=@prefix
          AND message_id NOT IN (SELECT value FROM json_each(@excluded))
          AND EXISTS(SELECT 1 FROM chat_connections c WHERE c.chat_id=a.chat_id AND c.generation=a.generation AND c.state='active')
          ORDER BY state='approved' DESC, kind='name' DESC, received_at, message_id LIMIT 1`,
              )
              .get({ prefix, now, excluded: JSON.stringify(excluded) }) as
              StoredGroupReplyAssessment | undefined;
          })
          .immediate(),
      );
    },
    valid(scope: ConnectionScope, messageId: number, now: number) {
      return lifecycle.transaction(scope, (db) => {
        const row = readGroupReplyAssessment(db, scope, messageId);
        return row && groupReplyAssessmentCurrent(db, scope, row, now) ? row : null;
      });
    },
    reserve(
      scope: ConnectionScope,
      messageId: number,
      attemptKey: string,
      sourceIds: readonly number[],
      frontier: number,
      now: number,
    ) {
      return lifecycle.transaction(scope, (db) => {
        const row = readGroupReplyAssessment(db, scope, messageId);
        if (!row || row.state !== 'waiting') return false;
        const ids = [...new Set([messageId, ...sourceIds])];
        const current = groupReplyAssessmentCurrent(db, scope, row, now);
        if (
          !current ||
          ids.some((id) => id <= current.floor) ||
          !historySourcesVisible(db, scope.chatId, ids, now)
        )
          return false;
        return (
          db
            .prepare(
              `UPDATE group_reply_assessments SET state='reserved',attempt_key=@attemptKey,
          source_ids=@sources,frontier=@frontier,revision=@revision,resume_allowed=0 WHERE ${key} AND state='waiting'`,
            )
            .run({
              ...scope,
              messageId,
              attemptKey,
              sources: JSON.stringify(ids),
              frontier,
              revision: current.revision,
            }).changes === 1
        );
      });
    },
    sent(scope: ConnectionScope, messageId: number, attemptKey: string, now: number) {
      return lifecycle.transaction(scope, (db) => {
        const row = readGroupReplyAssessment(db, scope, messageId);
        if (row?.state !== 'reserved' || !groupReplyAssessmentCurrent(db, scope, row, now))
          return false;
        return (
          db
            .prepare(
              `UPDATE group_reply_assessments SET state='sent' WHERE ${key}
          AND state='reserved' AND attempt_key=@attemptKey`,
            )
            .run({ ...scope, messageId, attemptKey }).changes === 1
        );
      });
    },
    finish(
      scope: ConnectionScope,
      messageId: number,
      attemptKey: string,
      outcome: GateOutcome,
      latencyMs: number,
      now: number,
    ) {
      return lifecycle.transaction(scope, (db) => {
        const row = readGroupReplyAssessment(db, scope, messageId);
        if (row?.state !== 'sent' || row.attemptKey !== attemptKey) return false;
        const selected =
          outcome === 'answer' && !groupReplyAssessmentCurrent(db, scope, row, now)
            ? 'cancelled'
            : outcome;
        return (
          db
            .prepare(
              `UPDATE group_reply_assessments SET state=@state,outcome=@outcome,latency_ms=@latency
          WHERE ${key} AND state='sent' AND attempt_key=@attemptKey`,
            )
            .run({
              ...scope,
              messageId,
              attemptKey,
              outcome: selected,
              state: selected === 'answer' ? 'approved' : 'finished',
              latency: latencyMs,
            }).changes === 1
        );
      });
    },
    cancel(scope: ConnectionScope, messageId: number) {
      return lifecycle.transaction(
        scope,
        (db) =>
          db
            .prepare(
              `UPDATE group_reply_assessments
        SET state='finished',outcome='cancelled' WHERE ${key} AND state IN ('waiting','reserved','approved')`,
            )
            .run({ ...scope, messageId }).changes === 1,
      );
    },
  };
}

const stores = new WeakMap<Storage, ReturnType<typeof createGroupReplyGateStore>>();

export function registerGroupReplyGate(
  storage: Storage,
  store: ReturnType<typeof createGroupReplyGateStore>,
) {
  stores.set(storage, store);
}

export function groupReplyGateStore(storage: Storage) {
  const store = stores.get(storage);
  requireInput(store);
  return store;
}
