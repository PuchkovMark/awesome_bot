import {
  acceptsHistoryInput,
  applyHistoryRetention,
  historySourcesVisible,
  pruneHistoryMessages,
} from './history-retention-store';
import { initialTrace, startTrace, minimalTrace } from './trace-store';
import type { TraceBackend } from './trace-store';
import type { TracePayload } from './trace-types';
import { encodeTrace } from './trace-validation';
import { createChatStore } from './chats';
import type { RoutedQueueCallback, RoutedAdmission, RouteMetadata } from './queue-types';
import { createMessageStore, readMessage, validateMessage } from './messages';
import type { MessageInput } from './types';
import type { LlmUsage } from '../llm/types';
import type { QueueConfig, QueueDecision, QueueAdmission } from './queue-types';
import type { Database } from 'better-sqlite3';
import type { ConnectionScope } from '../contracts/index';
import type { Connection } from './connection';
import type { LifecycleBackend } from './lifecycle-store';
import type { QueueWork, QueueOutcome, QueueRecord } from './queue-types';
import { StorageError } from './errors';
import { requireInput, timestamp } from './validation';
import { readChatControl } from './chat-control-store';
import { admitRequestQuota, pruneRequestQuota, releaseRequestQuota } from './request-quota-store';
import {
  canReserveTokens,
  deleteUnsentTokenReservation,
  insertTokenReservation,
  pruneTokenBudget,
  reconcileTokenReservation,
  type TokenReservation,
} from './token-budget-store';
import {
  createAutonomousQuotaStore,
  autonomousQuotaState,
  recordAutonomousReaction,
  pruneAutonomousQuota,
  restoreAutonomousQuota,
  type AutonomousReservation,
} from './autonomous-quota-store';
import { activeMentionFlood, admitMention, pruneMentionFlood } from './mention-flood-store';
import {
  finishResponse,
  noticePeriodAvailable,
  pruneResponseRate,
  recoverResponseRate,
  responseAlreadyStarted,
  responseSlotAvailable,
  startResponse,
} from './response-rate-store';
import type { ResponseRateOutcome } from './response-rate-store';
import type { NoticeBackend, NoticeReceipt } from './notice-types';
import type { FloodNotice, ResponsePublication, ResponsePublicationAdmission } from './queue-types';
import type { ResponseRateConfig } from '../core/chat-limits/response-rate-config';
import type { ChatLimits } from '../core/chat-limits/config';
import {
  dueQuestions,
  initiativeDenial,
  questionEvidence,
  removeWaitingQuestion,
  waitForQuestion,
} from './autonomous-questions';
import type { DirectRoute, InitiativeDenial } from './queue-types';
import type { InitiativeCause } from '../core/message-router/autonomous-rules';
export function createQueueBackend(
  connection: Connection,
  lifecycle: LifecycleBackend,
  traces: TraceBackend,
  messageRetentionDays?: number,
) {
  const retentionMs =
    messageRetentionDays === undefined ? undefined : messageRetentionDays * 86_400_000;
  const sources = new WeakMap<QueueWork, readonly number[]>();
  const runningRevisions = new WeakMap<QueueWork, number>();
  type QuotaStore = ReturnType<typeof createAutonomousQuotaStore>;
  const initiativePublications = new WeakMap<
    ResponsePublication,
    {
      reservation: AutonomousReservation;
      attempt: number;
      quota: QuotaStore;
    }
  >();
  function owned(db: Database, token: string) {
    const row = db
      .prepare('SELECT token,expires_at AS expires FROM queue_lease WHERE singleton=1')
      .get() as { token: string | null; expires: number };
    if (row.token !== token || row.expires <= Date.now())
      throw new StorageError('queue_lost_ownership');
  }
  function transaction<T>(token: string, operation: (db: Database) => T): T {
    return connection.run((db) =>
      db
        .transaction(() => {
          owned(db, token);
          const result = operation(db);
          owned(db, token);
          return result;
        })
        .immediate(),
    );
  }
  function currentWork(db: Database, work: QueueWork): boolean {
    const expected = runningRevisions.get(work);
    if (expected === undefined) return false;
    try {
      if (lifecycle.assertScope(db, work.scope).revision !== expected) return false;
      if (!work.route) return true;
      return (
        readChatControl(db, work.scope.chatId).responseRevision === (work.controlRevision ?? 0)
      );
    } catch (error) {
      if (
        error instanceof StorageError &&
        (error.code === 'stale_scope' || error.code === 'uncertain_connection')
      )
        return false;
      throw error;
    }
  }
  function turn(db: Database, scope: { readonly chatId: string; readonly generation: number }) {
    const row = db
      .prepare(
        'UPDATE queue_lease SET sequence=sequence+1 WHERE singleton=1 AND sequence<9007199254740991 RETURNING sequence',
      )
      .get() as { sequence: number } | undefined;
    if (!row) throw new StorageError('operation_failed');
    db.prepare(
      'INSERT INTO queue_turns(chat_id,generation,served) VALUES(?,?,?) ON CONFLICT(chat_id) DO UPDATE SET served=excluded.served',
    ).run(scope.chatId, scope.generation, row.sequence);
  }
  function canQueue(db: Database, chatId: string, config: QueueConfig, now: number) {
    const { total, local } = db
      .prepare(
        `SELECT count(*) AS total,count(CASE WHEN chat_id=? THEN 1 END) AS local
      FROM queue_jobs WHERE state='queued' AND expires_at>?`,
      )
      .get(chatId, now) as { total: number; local: number };
    return total < config.maxQueuedTotal && local < config.maxQueuedPerChat;
  }
  function initializeTurn(db: Database, scope: ConnectionScope) {
    if (
      !db
        .prepare(
          "SELECT 1 FROM queue_jobs WHERE chat_id=? AND state IN ('queued','running') LIMIT 1",
        )
        .get(scope.chatId)
    )
      turn(db, scope);
  }
  function initiativeRoute(cause: InitiativeCause): RouteMetadata {
    return { kind: 'initiative', mode: 'active', isGroupChat: true, cause };
  }
  function currentInitiative(
    db: Database,
    work: QueueWork,
    now: number,
  ): InitiativeDenial | undefined {
    if (work.route?.kind !== 'initiative') return undefined;
    if (!currentWork(db, work)) return 'initiative_mode';
    const revision = db
      .prepare('SELECT initiative_revision AS revision FROM queue_jobs WHERE id=?')
      .get(work.id) as { revision: number | null } | undefined;
    if (
      revision?.revision == null ||
      revision.revision !== lifecycle.assertScope(db, work.scope).revision
    )
      return 'initiative_mode';
    const denial = initiativeDenial(
      db,
      work.scope.chatId,
      work.messageId,
      work.initiativeEvidenceId,
      work.route.cause === 'unanswered',
      now,
    );
    return (
      denial ?? (activeMentionFlood(db, work.scope, now) !== null ? 'initiative_flood' : undefined)
    );
  }
  function beforeInitiative(
    db: Database,
    work: QueueWork,
    limits: ChatLimits | undefined,
    responseRate: ResponseRateConfig | undefined,
    now: number,
  ): InitiativeDenial | undefined {
    if (work.route?.kind !== 'initiative') return undefined;
    if (work.expiresAt !== undefined && work.expiresAt <= now) return 'initiative_expired';
    const denial = currentInitiative(db, work, now);
    if (denial) return denial;
    if (!limits || !autonomousQuotaState(db, work.scope, limits, now, true).allowed)
      return 'initiative_quota';
    if (
      !responseRate ||
      !responseSlotAvailable(db, work.scope, responseRate.responsesPerMinute, now)
    )
      return 'initiative_quota';
    return undefined;
  }
  function running(db: Database, token: string, work: QueueWork): boolean {
    return (
      currentWork(db, work) &&
      historySourcesVisible(db, work.scope.chatId, sources.get(work) ?? [work.messageId]) &&
      !!db
        .prepare(
          `SELECT j.id FROM queue_jobs j
      JOIN chat_connections c ON c.chat_id=j.chat_id AND c.generation=j.generation
      LEFT JOIN chats s ON s.chat_id=j.chat_id
      WHERE j.id=? AND j.owner=? AND j.state='running' AND c.state='active'
        AND coalesce(s.enabled,1)=1 AND (j.route_kind IS NULL OR s.response_mode!='silent')`,
        )
        .get(work.id, token)
    );
  }
  const messages = createMessageStore(connection);
  return {
    transaction,
    historyConfigured: retentionMs !== undefined,
    admitRouted(
      token: string,
      scope: ConnectionScope,
      message: MessageInput,
      decision: RoutedQueueCallback,
      config: QueueConfig,
      guard?: import('./queue-types').RoutedAdmissionGuard,
      responseRate?: ResponseRateConfig,
      autonomous = false,
    ): RoutedAdmission {
      return transaction(token, () =>
        lifecycle.transaction(scope, (db) => {
          const gate = guard?.();
          if (gate && !gate.journal) return { admission: { status: 'paused' }, decision: null };
          let chosen: import('./queue-types').RoutedQueueDecision | null = null;
          let floodNotice: FloodNotice | undefined;
          const admission = this.admit(
            token,
            scope,
            message,
            (snapshot) => {
              const settings = createChatStore(connection).get(scope.chatId);
              requireInput(settings);
              if (
                autonomous &&
                message.isGroupChat &&
                message.senderBot === false &&
                message.replyToMessageId
              ) {
                recordAutonomousReaction(db, scope, message.replyToMessageId, snapshot.receivedAt);
              }
              const value: unknown =
                gate && !gate.respond
                  ? { route: null, reason: 'forbidden' }
                  : decision(Object.freeze({ ...snapshot, settings: Object.freeze(settings) }));
              if (value instanceof Promise) {
                void value.catch(() => {});
                throw new StorageError('invalid_input');
              }
              requireInput(value !== null && typeof value === 'object');
              const routed = value as import('./queue-types').RoutedQueueDecision;
              requireInput(
                [
                  'direct_message',
                  'mention',
                  'reply',
                  'name',
                  'service',
                  'disabled',
                  'silent',
                  'sender_bot',
                  'sender_unknown',
                  'invalid_input',
                  'not_addressed',
                  'forbidden',
                  'reply_unknown',
                  'reply_other',
                  'mention_flood',
                ].includes(routed.reason),
              );
              if (routed.route !== null) {
                requireInput(
                  ['direct_message', 'mention', 'reply', 'name'].includes(routed.route.kind) &&
                    ['normal', 'active'].includes(routed.route.mode) &&
                    typeof routed.route.isGroupChat === 'boolean' &&
                    routed.reason === routed.route.kind,
                );
              }
              if (routed.initiative !== undefined)
                requireInput(
                  routed.route === null &&
                    routed.reason === 'not_addressed' &&
                    ['help', 'free_mention', 'unanswered'].includes(routed.initiative),
                );
              const result: import('./queue-types').RoutedQueueDecision =
                gate?.ordinary === false && routed.route
                  ? { route: null, reason: 'silent' }
                  : routed;
              const route = result.route;
              if (responseRate && route?.isGroupChat) {
                const now = snapshot.receivedAt;
                const messageId = snapshot.message.id;
                const mention =
                  route.kind === 'mention'
                    ? admitMention(db, scope, messageId, responseRate, now)
                    : null;
                if (mention?.active || (!mention && activeMentionFlood(db, scope, now) !== null)) {
                  if (
                    mention?.opened &&
                    responseSlotAvailable(db, scope, responseRate.responsesPerMinute, now) &&
                    noticePeriodAvailable(db, scope, now)
                  ) {
                    floodNotice = {
                      messageId,
                      receivedAt: now,
                      route,
                      controlRevision: readChatControl(db, scope.chatId).responseRevision,
                      disclosureVersion: gate?.version ?? null,
                    };
                  }
                  chosen = { reason: 'mention_flood', route: null };
                  return false;
                }
              }
              chosen = Object.freeze({
                reason: result.reason,
                route: route === null ? null : Object.freeze({ ...route }),
                ...(gate?.ordinary !== false && result.initiative
                  ? { initiative: result.initiative }
                  : {}),
              });
              if (!autonomous || !chosen.initiative) return chosen.route !== null;
              if (chosen.initiative !== 'unanswered') return true;
              if (
                snapshot.receivedAt < snapshot.message.timestamp + 300_000 &&
                Number.isSafeInteger(snapshot.message.timestamp + 300_000)
              ) {
                waitForQuestion(
                  db,
                  scope,
                  snapshot.message.id,
                  snapshot.message.timestamp,
                  lifecycle.assertScope(db, scope).revision,
                  readChatControl(db, scope.chatId).responseRevision,
                  gate?.version ?? null,
                );
              }
              return false;
            },
            config,
          );
          const routed = chosen as import('./queue-types').RoutedQueueDecision | null;
          const route = routed?.route;
          if (admission.status === 'queued' && route) {
            const revision = readChatControl(db, scope.chatId).responseRevision;
            db.prepare(
              'UPDATE queue_jobs SET route_kind=?,route_mode=?,route_group=?,disclosure_version=?,control_revision=? WHERE id=?',
            ).run(
              route.kind,
              route.mode,
              route.isGroupChat ? 1 : 0,
              gate?.version ?? null,
              revision,
              admission.jobId,
            );
          }
          if (autonomous && admission.status === 'queued' && routed?.initiative) {
            db.prepare(
              `UPDATE queue_jobs SET route_mode='active',route_group=1,disclosure_version=?,
              control_revision=?,initiative_cause=?,initiative_revision=? WHERE id=?`,
            ).run(
              gate?.version ?? null,
              readChatControl(db, scope.chatId).responseRevision,
              routed.initiative,
              lifecycle.assertScope(db, scope).revision,
              admission.jobId,
            );
          }
          return Object.freeze({
            admission,
            decision: chosen,
            ...(floodNotice ? { floodNotice: Object.freeze(floodNotice) } : {}),
          });
        }),
      );
    },
    admit(
      token: string,
      scope: ConnectionScope,
      message: MessageInput,
      decision: QueueDecision,
      config: QueueConfig,
    ): QueueAdmission {
      const snapshotMessage = { ...message };
      requireInput(typeof decision === 'function');
      return transaction(token, () =>
        lifecycle.transaction(scope, (db) => {
          requireInput(snapshotMessage.chatId === scope.chatId);
          const enabled = db
            .prepare('SELECT enabled FROM chats WHERE chat_id=?')
            .get(scope.chatId) as { enabled: number } | undefined;
          requireInput(enabled?.enabled !== 0);
          validateMessage(snapshotMessage);
          if (!acceptsHistoryInput(db, scope, snapshotMessage))
            return { status: 'history_unavailable' };
          const appended = messages.append(snapshotMessage);
          if (appended.status === 'duplicate')
            return { status: 'duplicate', messageId: appended.id };
          const now = Date.now();
          const expires = now + config.maxQueueAgeMs;
          timestamp(expires);
          const snapshot = Object.freeze({
            message: Object.freeze(readMessage(db, scope.chatId, appended.id)!),
            receivedAt: now,
          });
          const result: unknown = decision(snapshot);
          if (result instanceof Promise) {
            void result.catch(() => {});
            throw new StorageError('invalid_input');
          }
          requireInput(typeof result === 'boolean');
          if (!result) return { status: 'not_needed', messageId: appended.id };
          if (!canQueue(db, scope.chatId, config, now))
            return { status: 'queue_full', messageId: appended.id };
          initializeTurn(db, scope);
          const inserted = db
            .prepare(
              "INSERT INTO queue_jobs(chat_id,generation,message_id,received_at,expires_at,state) VALUES(?,?,?,?,?,'queued') RETURNING id",
            )
            .get(scope.chatId, scope.generation, appended.id, now, expires) as { id: number };
          return { status: 'queued', messageId: appended.id, jobId: inserted.id };
        }),
      );
    },
    acquire(
      token: string,
      leaseMs: number,
      safetyMs: number,
      config?: import('../core/response-tracing/config').TraceConfig,
      report?: (event: import('../core/response-tracing/metrics').TraceEvent) => void,
      pausePlatform?: string,
    ) {
      requireInput(typeof token === 'string' && token.length > 0);
      timestamp(leaseMs);
      timestamp(safetyMs);
      return connection.run((db) =>
        db
          .transaction(() => {
            const now = Date.now();
            timestamp(now + leaseMs);
            const row = db
              .prepare('SELECT token,expires_at AS expires FROM queue_lease WHERE singleton=1')
              .get() as { token: string | null; expires: number };
            if (row.token !== null && row.expires > now) throw new StorageError('queue_owned');
            if (config) traces.configure(config);
            if (report) traces.observe(report);
            db.prepare(
              'UPDATE queue_lease SET token=?,expires_at=?,safety_ms=? WHERE singleton=1',
            ).run(token, now + leaseMs, safetyMs);
            if (retentionMs !== undefined) applyHistoryRetention(db, retentionMs, now);
            const prefix = pausePlatform === undefined ? null : `${pausePlatform}:`;
            restoreAutonomousQuota(db, prefix);
            recoverResponseRate(db, prefix);
            if (pausePlatform !== undefined)
              lifecycle.pauseActivePlatform(db, pausePlatform, 'startup');
            const running = db
              .prepare(
                "SELECT j.id,j.chat_id AS chatId,j.generation,j.message_id AS messageId,j.received_at AS receivedAt FROM queue_jobs j WHERE j.state='running'",
              )
              .all() as {
              id: number;
              chatId: ConnectionScope['chatId'];
              generation: number;
              messageId: number;
              receivedAt: number;
            }[];
            for (const row of running) {
              const exists = db
                .prepare('SELECT payload FROM response_traces WHERE job_id=?')
                .get(row.id) as { payload: string } | undefined;
              if (!exists) {
                startTrace(
                  db,
                  { ...row, scope: row as unknown as ConnectionScope, route: null },
                  traces.config(),
                  now,
                );
                db.prepare('UPDATE response_traces SET payload=? WHERE job_id=?').run(
                  encodeTrace(
                    {
                      ...initialTrace(),
                      model: { name: null, invoked: 'possible' },
                      summary: null,
                      degraded: true,
                      degradation: 'legacy_metadata_missing',
                    },
                    traces.config().maxRecordBytes,
                  ),
                  row.id,
                );
              }
            }
            const open = db
              .prepare('SELECT job_id,payload FROM response_traces WHERE finished_at IS NULL')
              .all() as { job_id: number; payload: string }[];
            for (const row of open) {
              const payload = JSON.parse(row.payload) as TracePayload;
              db.prepare(
                "UPDATE response_traces SET finished_at=max(started_at,?),outcome='interrupted',payload=? WHERE job_id=?",
              ).run(
                now,
                encodeTrace(
                  {
                    ...payload,
                    resultKind: 'interrupted',
                    publication: {
                      rowId: 'silent_outcome',
                      tableVersion: 1,
                      reaction: 'silence',
                      status: 'suppressed',
                      reason: 'guard',
                    },
                  },
                  traces.config().maxRecordBytes,
                ),
                row.job_id,
              );
            }
            if (retentionMs === undefined)
              db.prepare(
                'DELETE FROM response_traces WHERE job_id IN (SELECT job_id FROM response_traces WHERE expires_at<=? AND finished_at IS NOT NULL LIMIT 100)',
              ).run(now);
            const recovered = db
              .prepare(
                "UPDATE queue_jobs SET state='terminal',outcome='interrupted',owner=NULL WHERE state='running'",
              )
              .run().changes;
            owned(db, token);
            return recovered;
          })
          .immediate(),
      );
    },
    pruneHistory(token: string) {
      if (retentionMs === undefined) return false;
      const now = Date.now();
      const tracesDeleted = transaction(
        token,
        (db) =>
          db
            .prepare(
              `DELETE FROM response_traces WHERE job_id IN (
        SELECT job_id FROM response_traces WHERE expires_at<=? AND finished_at IS NOT NULL LIMIT 100)`,
            )
            .run(now).changes,
      );
      return (
        transaction(token, (db) => pruneHistoryMessages(db, retentionMs, now)) ||
        tracesDeleted === 100
      );
    },
    renew(token: string, leaseMs: number) {
      return transaction(token, (db) => {
        const expires = Date.now() + leaseMs;
        timestamp(expires);
        db.prepare('UPDATE queue_lease SET expires_at=? WHERE singleton=1').run(expires);
      });
    },
    release(token: string) {
      return connection.run((db) =>
        db
          .transaction(() => {
            owned(db, token);
            db.prepare(
              'UPDATE queue_lease SET token=NULL,expires_at=0,safety_ms=0 WHERE singleton=1',
            ).run();
          })
          .immediate(),
      );
    },
    check(token: string) {
      connection.run((db) => owned(db, token));
    },
    depth(token: string) {
      return transaction(token, (db) => ({
        depthQueued: (
          db.prepare("SELECT count(*) AS n FROM queue_jobs WHERE state='queued'").get() as {
            n: number;
          }
        ).n,
        depthRunning: (
          db.prepare("SELECT count(*) AS n FROM queue_jobs WHERE state='running'").get() as {
            n: number;
          }
        ).n,
      }));
    },
    expire(token: string) {
      return transaction(token, (db) => {
        const now = Date.now();
        const rows = db
          .prepare(
            "UPDATE queue_jobs SET state='terminal',outcome='expired' WHERE state='queued' AND expires_at<=? RETURNING received_at AS receivedAt",
          )
          .all(now) as { receivedAt: number }[];
        return rows.map((row) => Math.max(0, now - row.receivedAt));
      });
    },
    promoteQuestions(token: string, config: QueueConfig, platform?: string, now = Date.now()) {
      transaction(token, (db) => {
        for (const pending of dueQuestions(db, now, platform)) {
          const scope = lifecycle.restore(pending);
          const route = initiativeRoute('unanswered');
          const state = readChatControl(db, scope.chatId);
          const stale =
            lifecycle.assertScope(db, scope).revision !== pending.revision ||
            state.responseRevision !== pending.controlRevision;
          const answer = stale
            ? { denial: 'initiative_mode' as const }
            : questionEvidence(db, scope.chatId, pending.messageId, now);
          const evidence = 'id' in answer ? answer.id : undefined;
          const denial =
            'denial' in answer
              ? answer.denial
              : initiativeDenial(db, scope.chatId, pending.messageId, evidence, true, now);
          if (!denial && !canQueue(db, scope.chatId, config, now)) continue;
          if (!denial) initializeTurn(db, scope);
          const job = db
            .prepare(
              `INSERT INTO queue_jobs(chat_id,generation,message_id,received_at,expires_at,
            state,outcome,route_mode,route_group,disclosure_version,control_revision,initiative_cause,initiative_evidence,initiative_revision)
            VALUES(?,?,?,?,?,?,?,'active',1,?,?,'unanswered',?,?) RETURNING id`,
            )
            .get(
              scope.chatId,
              scope.generation,
              pending.messageId,
              now,
              Math.min(now + config.maxQueueAgeMs, pending.expiresAt),
              denial ? 'terminal' : 'queued',
              denial ? 'interrupted' : null,
              pending.disclosureVersion,
              pending.controlRevision,
              evidence ?? null,
              pending.revision,
            ) as { id: number };
          if (denial) {
            const trace = initialTrace(route);
            const settings = traces.config();
            startTrace(
              db,
              { id: job.id, scope, route, messageId: pending.messageId, receivedAt: now },
              settings,
              now,
            );
            db.prepare(
              "UPDATE response_traces SET finished_at=?,outcome='interrupted',payload=? WHERE job_id=?",
            ).run(
              now,
              encodeTrace(
                {
                  ...trace,
                  resultKind: 'interrupted',
                  publication: { ...trace.publication, status: 'suppressed', reason: denial },
                },
                settings.maxRecordBytes,
              ),
              job.id,
            );
          }
          removeWaitingQuestion(db, pending.messageId);
        }
      });
    },
    take(token: string, excluded: readonly string[] = [], platform?: string): QueueWork | null {
      return transaction(token, (db) => {
        const prefix = platform === undefined ? null : platform + ':';
        const row = db
          .prepare(
            `SELECT j.id,j.chat_id AS chatId,j.generation,j.message_id AS messageId,j.received_at AS receivedAt,j.route_kind AS routeKind,j.route_mode AS routeMode,j.route_group AS routeGroup,j.disclosure_version AS disclosureVersion,j.control_revision AS controlRevision,
          j.initiative_cause AS initiativeCause,j.initiative_evidence AS evidenceId,j.expires_at AS expiresAt
          FROM queue_jobs j JOIN chat_connections c ON c.chat_id=j.chat_id AND c.generation=j.generation
          LEFT JOIN chats s ON s.chat_id=j.chat_id LEFT JOIN queue_turns t ON t.chat_id=j.chat_id
          WHERE j.state='queued' AND j.expires_at>? AND c.state='active' AND coalesce(s.enabled,1)=1
          AND (? IS NULL OR substr(j.chat_id,1,length(?))=?)
          AND NOT EXISTS(SELECT 1 FROM queue_jobs r WHERE r.chat_id=j.chat_id AND r.state='running')
          AND j.chat_id NOT IN (SELECT value FROM json_each(?))
          ORDER BY coalesce(t.served,0),j.id LIMIT 1`,
          )
          .get(Date.now(), prefix, prefix, prefix, JSON.stringify(excluded)) as
          | {
              routeKind: DirectRoute['kind'] | null;
              routeMode: RouteMetadata['mode'] | null;
              routeGroup: number | null;
              disclosureVersion: number | null;
              controlRevision: number;
              id: number;
              chatId: ConnectionScope['chatId'];
              generation: number;
              messageId: number;
              receivedAt: number;
              initiativeCause: InitiativeCause | null;
              evidenceId: number | null;
              expiresAt: number;
            }
          | undefined;
        if (!row) return null;
        const scope = lifecycle.restore(row);
        db.prepare("UPDATE queue_jobs SET state='running',owner=? WHERE id=?").run(token, row.id);
        const work = Object.freeze({
          id: row.id,
          scope,
          messageId: row.messageId,
          receivedAt: row.receivedAt,
          route: row.initiativeCause
            ? Object.freeze(initiativeRoute(row.initiativeCause))
            : row.routeKind && row.routeMode && row.routeGroup !== null
              ? Object.freeze({
                  kind: row.routeKind,
                  mode: row.routeMode,
                  isGroupChat: row.routeGroup === 1,
                })
              : null,
          controlRevision: row.controlRevision,
          expiresAt: row.expiresAt,
          ...(row.evidenceId === null ? {} : { initiativeEvidenceId: row.evidenceId }),
          ...(row.disclosureVersion === null ? {} : { disclosureVersion: row.disclosureVersion }),
        });
        runningRevisions.set(work, lifecycle.assertScope(db, scope).revision);
        startTrace(db, work, traces.config());
        return work;
      });
    },
    valid(token: string, work: QueueWork): boolean {
      return transaction(token, (db) => running(db, token, work));
    },
    checkInitiative(
      token: string,
      work: QueueWork,
      limits: ChatLimits | undefined,
      responseRate: ResponseRateConfig | undefined,
    ) {
      return transaction(token, (db) =>
        beforeInitiative(db, work, limits, responseRate, Date.now()),
      );
    },
    checkInitiativePublication(token: string, work: QueueWork) {
      return transaction(token, (db) => currentInitiative(db, work, Date.now()));
    },
    admitModelAttempt(
      token: string,
      work: QueueWork,
      limits: ChatLimits | undefined,
      allow: () => boolean,
      now = Date.now,
      contextIds: readonly number[] = [],
      responseRate?: ResponseRateConfig,
      reservation?: TokenReservation,
    ) {
      return transaction(token, (db) => {
        if (!running(db, token, work) || !allow()) return false;
        const at = now();
        if (beforeInitiative(db, work, limits, responseRate, at)) return false;
        if (
          responseRate &&
          work.route?.isGroupChat &&
          !sources.has(work) &&
          activeMentionFlood(db, work.scope, at) !== null
        )
          return false;
        const ids = sources.get(work) ?? [...new Set([work.messageId, ...contextIds])];
        if (!historySourcesVisible(db, work.scope.chatId, ids, at)) return 'context_stale' as const;
        if (
          reservation &&
          !canReserveTokens(db, work.scope, work.route?.isGroupChat ?? false, reservation, at)
        )
          return reservation.purpose === 'initiative'
            ? ('initiative_budget_exhausted' as const)
            : ('token_budget_exhausted' as const);
        const quota =
          limits && work.route && work.route.kind !== 'initiative'
            ? admitRequestQuota(db, work, limits, at)
            : true;
        if (quota === false || quota === 'quota_exhausted') return quota;
        if (reservation) insertTokenReservation(db, work.scope, reservation, at);
        sources.set(work, ids);

        if (!reservation) return true;
        const { key } = reservation;
        return {
          recordUsage(usage: LlmUsage) {
            // Результат уже допущенной попытки может прийти после остановки задания.
            connection.run((database) =>
              reconcileTokenReservation(database, work.scope, key, usage),
            );
          },
          cancelBeforeSend() {
            connection.run((database) =>
              database
                .transaction(() => {
                  if (
                    deleteUnsentTokenReservation(database, work.scope, key) &&
                    quota === 'charged'
                  ) {
                    releaseRequestQuota(database, work);
                  }
                })
                .immediate(),
            );
          },
        };
      });
    },
    pruneTokenBudget(token: string, now = Date.now()) {
      return transaction(token, (db) => pruneTokenBudget(db, now));
    },
    currentPublicationFlood(token: string, input: ResponsePublication, now = Date.now()): boolean {
      return transaction(token, () =>
        lifecycle.transaction(
          input.scope,
          (db) =>
            !!input.flood &&
            activeMentionFlood(db, input.scope, now) === input.flood.messageId &&
            readChatControl(db, input.scope.chatId).responseRevision ===
              input.flood.controlRevision,
        ),
      );
    },
    startPublication(
      token: string,
      input: ResponsePublication,
      config: ResponseRateConfig,
      notices: NoticeBackend,
      isCurrent: () => boolean,
      now = Date.now(),
      quota?: QuotaStore,
    ): ResponsePublicationAdmission {
      const { scope, key, messageId, route, notice, flood } = input;
      return transaction(token, () =>
        lifecycle.transaction(scope, (db) => {
          if (
            !isCurrent() ||
            !route.isGroupChat ||
            !historySourcesVisible(db, scope.chatId, [messageId]) ||
            responseAlreadyStarted(db, scope, key)
          )
            return { allowed: false, reason: 'guard' };
          if (
            flood &&
            (activeMentionFlood(db, scope, now) !== flood.messageId ||
              readChatControl(db, scope.chatId).responseRevision !== flood.controlRevision)
          )
            return { allowed: false, reason: 'guard' };
          if (!responseSlotAvailable(db, scope, config.responsesPerMinute, now))
            return { allowed: false, reason: 'response_rate' };
          const permit = notice
            ? notices.reserve(scope, messageId, route, notice.interval, now, notice.kind)
            : null;
          if (notice && !permit) return { allowed: false, reason: 'notice_period' };
          if (route.kind === 'initiative') {
            const reservation = quota?.reserve(scope, now, true);
            if (!quota || !reservation) return { allowed: false, reason: 'initiative_quota' };
            const attempt = quota.beginAttempt(reservation, now);
            if (attempt === null) {
              quota.finish(reservation);
              return { allowed: false, reason: 'initiative_pause' };
            }
            initiativePublications.set(input, { quota, reservation, attempt });
          }
          startResponse(db, scope, key, now);
          return permit ? { allowed: true, permit } : { allowed: true };
        }),
      );
    },
    repeatInitiative(input: ResponsePublication) {
      const active = initiativePublications.get(input);
      if (active)
        active.quota.repeatUnconfirmedAttempt(active.reservation, active.attempt, Date.now());
    },
    confirmInitiative(
      token: string,
      input: ResponsePublication,
      notices: NoticeBackend,
      receipt: NoticeReceipt,
      text: string,
      replyToMessageId: string | undefined,
      isCurrent: () => boolean,
    ) {
      transaction(token, () => {
        const active = initiativePublications.get(input);
        requireInput(active);
        notices.recordAnswer(input.scope, receipt, text, replyToMessageId, isCurrent);
        requireInput(
          active.quota.recordDeliveredPart(
            active.reservation,
            active.attempt,
            receipt.messageId,
            Date.now(),
          ),
        );
      });
    },
    finishPublication(token: string, input: ResponsePublication, outcome: ResponseRateOutcome) {
      transaction(token, (db) => {
        finishResponse(db, input.scope, input.key, outcome);
        const active = initiativePublications.get(input);
        if (active) {
          if (outcome === 'failed') active.quota.rejectAttempt(active.reservation, active.attempt);
          active.quota.finish(active.reservation);
          initiativePublications.delete(input);
        }
      });
    },
    pruneResponseRate(token: string, config: ResponseRateConfig, now = Date.now()) {
      transaction(token, (db) => {
        pruneResponseRate(db, now);
        pruneMentionFlood(db, now, config.floodWindowMs);
      });
    },
    autonomousQuota(token: string, limits: ChatLimits, platform?: string) {
      return createAutonomousQuotaStore(
        (operation) => transaction(token, operation),
        (db, scope) => {
          requireInput(platform === undefined || scope.chatId.startsWith(`${platform}:`));
          lifecycle.assertScope(db, scope);
        },
        token,
        limits,
      );
    },
    pruneQuotas(token: string, limits: ChatLimits, platform?: string, now = Date.now()) {
      timestamp(now);
      const prefix = platform === undefined ? null : `${platform}:`;
      return transaction(token, (db) => ({
        requests: pruneRequestQuota(db, limits, now, prefix),
        autonomous: pruneAutonomousQuota(db, limits, now, prefix),
      }));
    },
    publicationValid(token: string, work: QueueWork): boolean {
      return transaction(token, (db) => {
        return (
          currentWork(db, work) &&
          !currentInitiative(db, work, Date.now()) &&
          historySourcesVisible(db, work.scope.chatId, sources.get(work) ?? [work.messageId]) &&
          !!db
            .prepare(
              "SELECT j.id FROM queue_jobs j JOIN chats s ON s.chat_id=j.chat_id WHERE j.id=? AND j.chat_id=? AND j.generation=? AND j.state='terminal' AND s.enabled=1 AND (j.route_kind IS NULL OR s.response_mode<>'silent')",
            )
            .get(work.id, work.scope.chatId, work.scope.generation)
        );
      });
    },
    progress(token: string, work: QueueWork, payload: TracePayload) {
      return transaction(token, (db) => {
        if (!this.valid(token, work)) return false;
        let json: string;
        try {
          json = encodeTrace(payload, traces.config().maxRecordBytes);
        } catch (error) {
          if (!(error instanceof StorageError) || error.code !== 'limit_exceeded') throw error;
          traces.report('size_exceeded');
          json = encodeTrace(
            minimalTrace(payload, 'size_exceeded'),
            traces.config().maxRecordBytes,
          );
          traces.report('minimal_saved');
        }
        return (
          db
            .prepare('UPDATE response_traces SET payload=? WHERE job_id=? AND finished_at IS NULL')
            .run(json, work.id).changes === 1
        );
      });
    },
    finish(
      token: string,
      work: QueueWork,
      outcome: QueueOutcome,
      payload?: TracePayload,
    ): QueueOutcome | null {
      const commit = (
        minimal: boolean,
        reason: 'write_failed' | 'size_exceeded' = 'write_failed',
      ): QueueOutcome | null =>
        transaction(token, (db) => {
          requireInput(
            [
              'completed',
              'failed',
              'rate_limit',
              'interrupted',
              'expired',
              'message_missing',
              'deadline_exceeded',
            ].includes(outcome),
          );
          const state = db
            .prepare('SELECT state FROM chat_connections WHERE chat_id=? AND generation=?')
            .get(work.scope.chatId, work.scope.generation) as { state: string } | undefined;
          const final = state?.state === 'active' ? outcome : 'interrupted';
          const result = db
            .prepare(
              "UPDATE queue_jobs SET state='terminal',outcome=?,owner=NULL WHERE id=? AND owner=? AND state='running'",
            )
            .run(final, work.id, token);
          if (result.changes !== 1) return null;
          const row = db
            .prepare('SELECT payload FROM response_traces WHERE job_id=?')
            .get(work.id) as { payload: string } | undefined;
          if (!row) throw new StorageError('operation_failed');
          const base = payload ?? (JSON.parse(row.payload) as TracePayload);
          const p: TracePayload = {
            ...base,
            resultKind: base.resultKind ?? final,
            publication:
              final === 'interrupted'
                ? {
                    rowId: 'silent_outcome',
                    tableVersion: 1,
                    reaction: 'silence',
                    status: 'suppressed',
                    reason: base.publication.reason.startsWith('initiative_')
                      ? base.publication.reason
                      : 'guard',
                  }
                : base.publication,
          };
          const json = encodeTrace(
            minimal ? minimalTrace(p, reason) : p,
            traces.config().maxRecordBytes,
          );
          db.prepare(
            'UPDATE response_traces SET finished_at=max(started_at,?),outcome=?,payload=? WHERE job_id=? AND finished_at IS NULL',
          ).run(Date.now(), final, json, work.id);
          if (
            db
              .prepare("SELECT id FROM queue_jobs WHERE chat_id=? AND state='queued' LIMIT 1")
              .get(work.scope.chatId)
          )
            turn(db, work.scope);
          return final;
        });
      try {
        return commit(false);
      } catch (error) {
        if (error instanceof StorageError && error.code === 'queue_lost_ownership') throw error;
        traces.report(
          error instanceof StorageError && error.code === 'limit_exceeded'
            ? 'size_exceeded'
            : 'full_write_failed',
        );
        try {
          const result = commit(
            true,
            error instanceof StorageError && error.code === 'limit_exceeded'
              ? 'size_exceeded'
              : 'write_failed',
          );
          traces.report('minimal_saved');
          return result;
        } catch {
          traces.report('trace_write_failed');
          throw new StorageError('operation_failed');
        }
      }
    },
    get(scope: ConnectionScope, id: number): QueueRecord | null {
      requireInput(Number.isSafeInteger(id) && id > 0);
      return lifecycle.transaction(
        scope,
        (db) =>
          (db
            .prepare(
              `SELECT id,message_id AS messageId,received_at AS receivedAt,expires_at AS expiresAt,state,outcome
        FROM queue_jobs WHERE chat_id=? AND generation=? AND id=?`,
            )
            .get(scope.chatId, scope.generation, id) as QueueRecord | undefined) ?? null,
      );
    },
  };
}
export type QueueBackend = ReturnType<typeof createQueueBackend>;
