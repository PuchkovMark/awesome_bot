import type { Database } from 'better-sqlite3';
import type { ChatId, ConnectionScope, UserId } from '../contracts/index';
import type { GroupReplyAssessment } from '../core/message-router/types';
import type { ChatLimits } from '../core/chat-limits/config';
import type { ResponseRateConfig } from '../core/chat-limits/response-rate-config';
import type { LlmUsage } from '../llm/types';
import { initiativeDenial } from './autonomous-questions';
import { autonomousQuotaState } from './autonomous-quota-store';
import { readChatControl } from './chat-control-store';
import { groupInitiativeDisclosed, readDisclosureGate } from './chat-disclosure-store';
import { recordFailedModelAttempt, recordSentModelAttempt } from './chat-request-metrics-store';
import type { Connection } from './connection';
import { historyBounds, historySourcesVisible } from './history-retention-store';
import type { LifecycleBackend } from './lifecycle-store';
import { activeMentionFlood } from './mention-flood-store';
import type { InitiativeDenial } from './queue-types';
import { responseSlotAvailable } from './response-rate-store';
import {
  canReserveTokens,
  deleteUnsentTokenReservation,
  insertTokenReservation,
  reconcileTokenReservation,
} from './token-budget-store';
import type { Storage } from './types';
import { requireInput, timestamp } from './validation';

const lifetimeMs = 120_000;
const maxWaitingPerChat = 2;
const maxWaiting = 32;
const unfinished = "state IN ('waiting','reserved','sent','approved')";
const key = 'message_id=@messageId AND (chat_id,generation)=(@chatId,@generation)';
const columns = `message_id AS messageId,chat_id AS chatId,generation,kind,mode,
  received_at AS receivedAt,expires_at AS expiresAt,revision,control_revision AS controlRevision,
  initiative_control_revision AS initiativeControlRevision,
  disclosure_version AS disclosureVersion,glossary_revision AS glossaryRevision,
  matched_name AS matchedName,
  reply_author_id AS replyAuthorId,other_address AS otherAddress,forwarded,state,resume_allowed AS resumeAllowed,
  attempt_key AS attemptKey,source_ids AS sourceIds,frontier,outcome,latency_ms AS latencyMs`;

type State = 'waiting' | 'reserved' | 'sent' | 'approved' | 'queued' | 'finished';
export type GateOutcome = 'answer' | 'silence' | 'failed' | 'cancelled' | 'expired' | 'uncertain';

export interface GroupReplySource {
  readonly id: number;
  readonly author: string;
  readonly authorName: string;
  readonly role: 'user' | 'assistant';
  readonly senderBot: number | null;
  readonly text: string;
}

export interface GroupReplyContext {
  readonly current: GroupReplySource;
  readonly quote?: GroupReplySource;
  readonly nearby: readonly GroupReplySource[];
  readonly glossary?: { readonly text: string | null; readonly revision: number };
}

export interface GroupReplyPolicy {
  readonly limits: ChatLimits;
  readonly responseRate: ResponseRateConfig;
}

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
  readonly initiativeControlRevision: number;
  readonly disclosureVersion: number;
  readonly glossaryRevision: number | null;
  readonly matchedName: number;
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

function initiativeControlRevision(db: Database, scope: ConnectionScope) {
  return (
    (db
      .prepare(
        `SELECT initiative_control_revision FROM chat_controls WHERE chat_id=? AND generation=?`,
      )
      .pluck()
      .get(scope.chatId, scope.generation) as number | undefined) ?? 0
  );
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
    message_id,chat_id,generation,kind,mode,received_at,expires_at,revision,control_revision,initiative_control_revision,
    disclosure_version,glossary_revision,matched_name,reply_author_id,other_address,forwarded,state
  ) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'waiting'
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
        initiativeControlRevision(db, scope),
        disclosureVersion,
        candidate.glossaryRevision ?? null,
        Number(candidate.matchedName === true),
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
  if (
    !chat ||
    row.chatId !== scope.chatId ||
    row.generation !== scope.generation ||
    (row.revision !== chat.revision && row.resumeAllowed !== 1)
  )
    return null;
  const control = readChatControl(db, scope.chatId);
  const disclosure = readDisclosureGate(db, scope);
  if (
    !control.enabled ||
    control.mode !== row.mode ||
    control.responseRevision !== row.controlRevision ||
    !disclosure.journal ||
    disclosure.version !== row.disclosureVersion ||
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

export function groupReplyInitiativeCurrent(
  db: Database,
  scope: ConnectionScope,
  row: StoredGroupReplyAssessment,
) {
  return row.initiativeControlRevision === initiativeControlRevision(db, scope);
}

export function groupInitiativeDenial(
  db: Database,
  scope: ConnectionScope,
  id: number,
  frontier: number | null,
  now: number,
): InitiativeDenial | undefined {
  if (!groupInitiativeDisclosed(db, scope)) return 'initiative_source';
  const denial = initiativeDenial(db, scope.chatId, id, undefined, false, now);
  if (denial) return denial;
  if (activeMentionFlood(db, scope, now) !== null) return 'initiative_flood';
  const bounds = historyBounds(db, scope.chatId, now);
  if (
    db
      .prepare(
        `SELECT 1 FROM personal_visible_messages
      WHERE chat_id=? AND id>? AND timestamp>? AND purpose='conversation'
        AND role='user' AND sender_bot=0
        AND (id>? OR reply_to_message_id=(SELECT platform_message_id FROM messages WHERE id=? AND chat_id=?))
      LIMIT 1`,
      )
      .get(
        scope.chatId,
        Math.max(id, bounds.clearedThrough),
        bounds.expiredThrough,
        frontier ?? Number.MAX_SAFE_INTEGER,
        id,
        scope.chatId,
      )
  )
    return 'initiative_answered';
  return undefined;
}

function groupInitiativeAvailable(
  db: Database,
  scope: ConnectionScope,
  id: number,
  now: number,
  policy: GroupReplyPolicy,
  frontier: number | null = null,
) {
  return (
    !groupInitiativeDenial(db, scope, id, frontier, now) &&
    autonomousQuotaState(db, scope, policy.limits, now, true).allowed &&
    responseSlotAvailable(db, scope, policy.responseRate.responsesPerMinute, now)
  );
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
  if (present) {
    const unsent = newer.prepare(`SELECT chat_id AS chatId,generation,attempt_key AS attemptKey
      FROM group_reply_assessments WHERE state='reserved' AND attempt_key IS NOT NULL`);
    for (const row of unsent.iterate() as Iterable<
      Pick<StoredGroupReplyAssessment, 'chatId' | 'generation'> & { attemptKey: string }
    >)
      deleteUnsentTokenReservation(staged, row, row.attemptKey);
  }
  const close = staged.prepare(`UPDATE group_reply_assessments SET state='finished',outcome=@outcome
    WHERE ${key} AND ${unfinished}`);
  const reset = staged.prepare(`UPDATE group_reply_assessments SET state='waiting',attempt_key=NULL,
    source_ids=NULL,frontier=NULL WHERE ${key}`);
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
      row.state === 'reserved' &&
      row.attemptKey &&
      (!current || current.state === 'waiting' || current.state === 'reserved')
    )
      deleteUnsentTokenReservation(staged, row, row.attemptKey);
    if (
      (row.state === 'waiting' || row.state === 'reserved') &&
      (current?.state === 'waiting' || current?.state === 'reserved')
    ) {
      reset.run(row);
      continue;
    }
    if (
      row.state === 'approved' &&
      current?.state === 'approved' &&
      row.attemptKey === current.attemptKey &&
      row.sourceIds === current.sourceIds &&
      row.frontier === current.frontier
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
    allowInitiative(
      scope: ConnectionScope,
      messageId: number,
      now: number,
      policy: GroupReplyPolicy,
    ) {
      return lifecycle.transaction(
        scope,
        (db) =>
          groupInitiativeAvailable(db, scope, messageId, now, policy) &&
          canReserveTokens(
            db,
            scope,
            true,
            { key: `eligibility:${messageId}`, purpose: 'gate_initiative', input: 1, output: 0 },
            now,
          ),
      );
    },
    useName(scope: ConnectionScope, messageId: number, now: number) {
      return lifecycle.transaction(scope, (db) => {
        const row = readGroupReplyAssessment(db, scope, messageId);
        if (
          row?.kind !== 'initiative' ||
          row.state !== 'waiting' ||
          row.matchedName !== 1 ||
          !groupReplyAssessmentCurrent(db, scope, row, now)
        )
          return null;
        db.prepare(`UPDATE group_reply_assessments SET kind='name' WHERE ${key}`).run({
          ...scope,
          messageId,
        });
        return { ...row, kind: 'name' as const };
      });
    },
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
              `DELETE FROM token_budget_attempts WHERE (chat_id,generation,attempt_key) IN (
                SELECT chat_id,generation,attempt_key FROM group_reply_assessments
                WHERE state='reserved' AND substr(chat_id,1,length(@prefix))=@prefix)`,
            ).run(params);
            db.prepare(
              `UPDATE group_reply_assessments SET state='waiting',attempt_key=NULL,source_ids=NULL,frontier=NULL
          WHERE state='reserved' AND substr(chat_id,1,length(@prefix))=@prefix`,
            ).run(params);
            db.prepare(
              `UPDATE group_reply_assessments SET resume_allowed=1
          WHERE substr(chat_id,1,length(@prefix))=@prefix AND (state IN ('waiting','approved')
            OR (state='queued' AND EXISTS(SELECT 1 FROM queue_jobs j
              WHERE j.message_id=group_reply_assessments.message_id
                AND j.group_reply_assessment IS NOT NULL AND j.state='queued')))`,
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
    context(scope: ConnectionScope, messageId: number, now: number): GroupReplyContext | null {
      return lifecycle.transaction(scope, (db) => {
        const row = readGroupReplyAssessment(db, scope, messageId);
        if (row?.state !== 'waiting') return null;
        const current = groupReplyAssessmentCurrent(db, scope, row, now);
        if (!current) return null;
        const bounds = historyBounds(db, scope.chatId, now);
        const floor = Math.max(bounds.clearedThrough, current.floor);
        const fields = `id,user_id AS author,substr(author_name,1,128) AS authorName,role,
          sender_bot AS senderBot,CASE WHEN length(CAST(text AS BLOB))<=4096 THEN text END AS text`;
        const visible = "chat_id=? AND id>? AND timestamp>? AND purpose='conversation'";
        const source = db
          .prepare(
            `SELECT ${fields},reply_to_message_id AS reply FROM personal_visible_messages
          WHERE ${visible} AND id=?`,
          )
          .get(scope.chatId, floor, bounds.expiredThrough, messageId) as
          (GroupReplySource & { reply: string | null }) | undefined;
        if (!source || source.text === null) return null;
        const { reply, ...input } = source;
        const quote =
          reply && row.replyAuthorId
            ? (db
                .prepare(
                  `SELECT ${fields} FROM personal_visible_messages
            WHERE ${visible} AND id<? AND platform_message_id=? AND user_id=?`,
                )
                .get(
                  scope.chatId,
                  floor,
                  bounds.expiredThrough,
                  messageId,
                  reply,
                  row.replyAuthorId,
                ) as GroupReplySource | undefined)
            : undefined;
        const nearby = db
          .prepare(
            `SELECT ${fields} FROM personal_visible_messages
          WHERE ${visible} AND id<=? AND id NOT IN (?,?) ORDER BY id DESC LIMIT 6`,
          )
          .all(
            scope.chatId,
            floor,
            bounds.expiredThrough,
            row.kind === 'name' ? messageId : Number.MAX_SAFE_INTEGER,
            messageId,
            quote?.id ?? 0,
          ) as GroupReplySource[];
        const glossary =
          row.glossaryRevision === null
            ? undefined
            : (db
                .prepare(
                  `
          SELECT text,revision FROM chat_passport_sections
          WHERE chat_id=? AND generation=? AND section='glossary' AND revision=?`,
                )
                .get(
                  scope.chatId,
                  scope.generation,
                  row.glossaryRevision,
                ) as GroupReplyContext['glossary']);
        return {
          current: input,
          ...(quote && quote.text !== null ? { quote } : {}),
          nearby: nearby.filter(({ text }) => text !== null),
          ...(glossary ? { glossary } : {}),
        };
      });
    },
    reserve(
      scope: ConnectionScope,
      messageId: number,
      attemptKey: string,
      sourceIds: readonly number[],
      frontier: number,
      now: number,
      tokens: { readonly input: number; readonly output: number },
      policy?: GroupReplyPolicy,
    ) {
      return lifecycle.transaction(scope, (db) => {
        const row = readGroupReplyAssessment(db, scope, messageId);
        if (!row || row.state !== 'waiting') return false;
        const ids = [...new Set([messageId, ...sourceIds])];
        const current = groupReplyAssessmentCurrent(db, scope, row, now);
        const attempt = {
          key: attemptKey,
          purpose: row.kind === 'name' ? ('gate_name' as const) : ('gate_initiative' as const),
          ...tokens,
        };
        if (
          !current ||
          (row.kind === 'initiative' &&
            (!policy ||
              !groupReplyInitiativeCurrent(db, scope, row) ||
              !groupInitiativeAvailable(db, scope, messageId, now, policy, frontier))) ||
          (row.kind === 'name' && activeMentionFlood(db, scope, now) !== null) ||
          ids.some((id) => id <= current.floor) ||
          !historySourcesVisible(db, scope.chatId, ids, now) ||
          !canReserveTokens(db, scope, true, attempt, now)
        )
          return false;
        insertTokenReservation(db, scope, attempt, now);
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
    sent(
      scope: ConnectionScope,
      messageId: number,
      attemptKey: string,
      now: number,
      policy?: GroupReplyPolicy,
    ) {
      return lifecycle.transaction(scope, (db) => {
        const row = readGroupReplyAssessment(db, scope, messageId);
        if (
          row?.state !== 'reserved' ||
          !groupReplyAssessmentCurrent(db, scope, row, now) ||
          (row.kind === 'initiative' &&
            (!policy ||
              !groupReplyInitiativeCurrent(db, scope, row) ||
              !groupInitiativeAvailable(db, scope, messageId, now, policy, row.frontier))) ||
          (row.kind === 'name' && activeMentionFlood(db, scope, now) !== null)
        )
          return false;
        const sent =
          db
            .prepare(
              `UPDATE group_reply_assessments SET state='sent' WHERE ${key}
          AND state='reserved' AND attempt_key=@attemptKey`,
            )
            .run({ ...scope, messageId, attemptKey }).changes === 1;
        if (sent) recordSentModelAttempt(db, scope, attemptKey, undefined, now);
        return sent;
      });
    },
    reconcile(scope: ConnectionScope, attemptKey: string, usage: LlmUsage) {
      return connection.run((db) => reconcileTokenReservation(db, scope, attemptKey, usage));
    },
    failed(scope: ConnectionScope, attemptKey: string) {
      return connection.run((db) =>
        db.transaction(() => recordFailedModelAttempt(db, scope, attemptKey)).immediate(),
      );
    },
    finish(
      scope: ConnectionScope,
      messageId: number,
      attemptKey: string,
      outcome: GateOutcome,
      latencyMs: number,
      now: number,
      promote?: () => void,
    ) {
      return connection.run((db) =>
        db
          .transaction(() => {
            const row = readGroupReplyAssessment(db, scope, messageId);
            if (row?.state !== 'sent' || row.attemptKey !== attemptKey) return false;
            const selected =
              outcome === 'answer' &&
              (!groupReplyAssessmentCurrent(db, scope, row, now) ||
                (row.kind === 'initiative' &&
                  (!groupReplyInitiativeCurrent(db, scope, row) ||
                    groupInitiativeDenial(db, scope, messageId, row.frontier, now))))
                ? 'cancelled'
                : outcome;
            const updated =
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
                }).changes === 1;
            if (updated && selected === 'answer') promote?.();
            return updated;
          })
          .immediate(),
      );
    },
    cancel(scope: ConnectionScope, messageId: number, attemptKey?: string) {
      return connection.run((db) =>
        db
          .transaction(() => {
            const row = readGroupReplyAssessment(db, scope, messageId);
            if (attemptKey && (!row || (row.state === 'reserved' && row.attemptKey === attemptKey)))
              deleteUnsentTokenReservation(db, scope, attemptKey);
            return (
              db
                .prepare(
                  `UPDATE group_reply_assessments SET state='finished',outcome='cancelled'
          WHERE ${key} AND ((state='waiting' AND @attemptKey IS NULL) OR (state='reserved' AND attempt_key=@attemptKey))`,
                )
                .run({ ...scope, messageId, attemptKey: attemptKey ?? null }).changes === 1
            );
          })
          .immediate(),
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
