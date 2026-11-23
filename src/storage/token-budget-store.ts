import type { Database } from 'better-sqlite3';
import type { ChatId, ConnectionScope, HumanMembership } from '../contracts/index';
import type { LlmUsage } from '../llm/types';
import type { LifecycleBackend } from './lifecycle-store';
import type { Connection } from './connection';
type BudgetScope = Pick<ConnectionScope, 'chatId' | 'generation'>;
import { StorageError } from './errors';
import { compositeId, object, requireInput, timestamp } from './validation';
import { createChatStore } from './chats';
import { applyParticipantSnapshot, participantSync } from './participant-registry';

export const tokenBudgetWindowMs = 86_400_000;
const tokensPerPerson = 15_000;

export interface TokenReservation {
  readonly key: string;
  readonly purpose: 'direct' | 'initiative' | 'profile_update' | 'summary';
  readonly input: number;
  readonly output: number;
}
/** Намерение родительской очереди, отдельно от списания за фактическую попытку. */
export type FinalBudget = { readonly protect: number } | 'consume';

export interface TokenBudgetPatch {
  readonly total?: number | null;
  readonly initiative?: number | null;
}
interface Spending {
  confirmed: bigint;
  reserved: bigint;
  incompleteAttempts: number;
}
interface Limits {
  readonly total: number | null;
  readonly initiative: number | null;
  readonly people: number | null;
}
type Attempt = {
  readonly purpose: TokenReservation['purpose'];
  readonly inputReserve: number;
  readonly outputReserve: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
};

function limits(db: Database, scope: BudgetScope): Limits {
  return (
    (db
      .prepare(
        'SELECT total_limit AS total,initiative_limit AS initiative,people FROM chat_token_budgets WHERE chat_id=? AND generation=?',
      )
      .get(scope.chatId, scope.generation) as Limits | undefined) ?? {
      total: null,
      initiative: null,
      people: null,
    }
  );
}

function addUsage(spending: Spending, attempt: Attempt) {
  for (const [tokens, reserve] of [
    [attempt.inputTokens, attempt.inputReserve],
    [attempt.outputTokens, attempt.outputReserve],
  ] as const) {
    if (tokens === null) spending.reserved += BigInt(reserve);
    else spending.confirmed += BigInt(tokens);
  }
  if (attempt.inputTokens === null || attempt.outputTokens === null) spending.incompleteAttempts++;
}

function balance(limit: number, spending: Spending) {
  const remaining = BigInt(limit) - spending.confirmed - spending.reserved;
  return { limit, remaining: remaining > 0n ? Number(remaining) : 0, ...spending };
}

function readBudget(
  db: Database,
  scope: BudgetScope,
  group: boolean,
  now: number,
  omitJob?: number,
) {
  timestamp(now);
  const settings = limits(db, scope);
  const total: Spending = { confirmed: 0n, reserved: 0n, incompleteAttempts: 0 };
  const initiative: Spending = { ...total };
  const profileUpdate: Spending = { ...total };
  for (const attempt of db
    .prepare(
      `SELECT purpose,input_reserve AS inputReserve,output_reserve AS outputReserve,
            input_tokens AS inputTokens,output_tokens AS outputTokens
       FROM token_budget_attempts WHERE chat_id=? AND generation=? AND admitted_at>? AND admitted_at<=?`,
    )
    .iterate(scope.chatId, scope.generation, now - tokenBudgetWindowMs, now) as Iterable<Attempt>) {
    addUsage(total, attempt);
    if (attempt.purpose === 'initiative') addUsage(initiative, attempt);
    if (attempt.purpose === 'profile_update') addUsage(profileUpdate, attempt);
  }
  for (const hold of db
    .prepare(
      `SELECT id,route_kind,final_budget FROM queue_jobs
    WHERE chat_id=? AND generation=? AND state='running' AND final_budget>0`,
    )
    .iterate(scope.chatId, scope.generation) as Iterable<{
    id: number;
    route_kind: string;
    final_budget: number;
  }>) {
    if (hold.id === omitJob) continue;
    total.reserved += BigInt(hold.final_budget);
    if (hold.route_kind === 'initiative') initiative.reserved += BigInt(hold.final_budget);
  }
  const totalLimit = settings.total ?? (group ? (settings.people ?? 1) * tokensPerPerson : 500_000);
  return {
    period: { from: now - tokenBudgetWindowMs, through: now },
    people: group ? settings.people : null,
    total: balance(totalLimit, total),
    profileUpdate: balance(Number(BigInt(totalLimit) / 20n), profileUpdate),
    initiative: group ? balance(settings.initiative ?? 10_000, initiative) : null,
  };
}

export function profileUpdateAllowance(
  db: Database,
  scope: BudgetScope,
  group: boolean,
  now: number,
) {
  const { total, profileUpdate } = readBudget(db, scope, group, now);
  return Math.min(total.remaining, profileUpdate.remaining);
}

export function canReserveTokens(
  db: Database,
  scope: ConnectionScope,
  group: boolean,
  attempt: TokenReservation,
  now: number,
  final?: { readonly jobId: number; readonly budget: FinalBudget },
) {
  requireInput(
    typeof attempt.key === 'string' && attempt.key.length > 0 && attempt.key.length <= 256,
  );
  requireInput(['direct', 'initiative', 'profile_update', 'summary'].includes(attempt.purpose));
  timestamp(attempt.input);
  timestamp(attempt.output);
  const current = readBudget(db, scope, group, now, final?.jobId);
  let protectedAmount = 0;
  if (final && final.budget !== 'consume') {
    timestamp(final.budget.protect);
    const prior = db
      .prepare(
        "SELECT final_budget FROM queue_jobs WHERE id=? AND chat_id=? AND generation=? AND state='running'",
      )
      .pluck()
      .get(final.jobId, scope.chatId, scope.generation);
    requireInput(typeof prior === 'number');
    protectedAmount = Math.max(prior, final.budget.protect);
  }
  timestamp(protectedAmount);
  const requested = BigInt(attempt.input) + BigInt(attempt.output) + BigInt(protectedAmount);
  if (current.total.confirmed + current.total.reserved + requested > BigInt(current.total.limit))
    return false;
  if (
    attempt.purpose === 'initiative' &&
    (!current.initiative ||
      current.initiative.confirmed + current.initiative.reserved + requested >
        BigInt(current.initiative.limit))
  )
    return false;
  if (attempt.purpose === 'profile_update' && requested > BigInt(current.profileUpdate.remaining))
    return false;
  return !db
    .prepare(
      'SELECT 1 FROM token_budget_attempts WHERE chat_id=? AND generation=? AND attempt_key=?',
    )
    .get(scope.chatId, scope.generation, attempt.key);
}

export function insertTokenReservation(
  db: Database,
  scope: ConnectionScope,
  attempt: TokenReservation,
  now: number,
) {
  db.prepare(
    `INSERT INTO token_budget_attempts(chat_id,generation,attempt_key,admitted_at,purpose,input_reserve,output_reserve)
     VALUES(?,?,?,?,?,?,?)`,
  ).run(
    scope.chatId,
    scope.generation,
    attempt.key,
    now,
    attempt.purpose,
    attempt.input,
    attempt.output,
  );
}

export function reconcileTokenReservation(
  db: Database,
  scope: ConnectionScope,
  key: string,
  usage: LlmUsage,
) {
  if (usage.input !== null) timestamp(usage.input);
  if (usage.output !== null) timestamp(usage.output);
  return (
    db
      .prepare(
        `UPDATE token_budget_attempts
       SET input_tokens=coalesce(input_tokens,?),output_tokens=coalesce(output_tokens,?)
       WHERE chat_id=? AND generation=? AND attempt_key=?`,
      )
      .run(usage.input, usage.output, scope.chatId, scope.generation, key).changes === 1
  );
}

export function deleteUnsentTokenReservation(db: Database, scope: ConnectionScope, key: string) {
  return (
    db
      .prepare(
        'DELETE FROM token_budget_attempts WHERE chat_id=? AND generation=? AND attempt_key=? AND input_tokens IS NULL AND output_tokens IS NULL',
      )
      .run(scope.chatId, scope.generation, key).changes === 1
  );
}

export function pruneTokenBudget(db: Database, now: number) {
  timestamp(now);
  return db
    .prepare(
      'DELETE FROM token_budget_attempts WHERE rowid IN (SELECT rowid FROM token_budget_attempts WHERE admitted_at<=? ORDER BY admitted_at LIMIT 1000)',
    )
    .run(now - tokenBudgetWindowMs).changes;
}

interface MembershipObservation extends BudgetScope {
  readonly number: number;
  readonly revision: number;
  readonly startedAt: number;
  readonly connectionRevision: number;
}

export function createTokenBudgetStore(connection: Connection, lifecycle: LifecycleBackend) {
  const chats = createChatStore(connection);
  return {
    overview(isGroupChat: (chatId: ChatId) => boolean, now: number) {
      timestamp(now);
      return connection.run((db) =>
        db.transaction(() => {
          const scopes = db
            .prepare('SELECT chat_id AS chatId,generation FROM chat_connections ORDER BY chat_id')
            .all() as BudgetScope[];
          const chats = scopes.map((scope) => ({
            ...scope,
            ...readBudget(db, scope, isGroupChat(scope.chatId), now),
          }));
          return { period: { from: now - tokenBudgetWindowMs, through: now }, chats };
        })(),
      );
    },
    read(scope: ConnectionScope, group: boolean, now: number) {
      return lifecycle.transaction(scope, (db) => readBudget(db, scope, group, now));
    },
    update(scope: ConnectionScope, group: boolean, patch: TokenBudgetPatch, now: number) {
      object(patch, ['total', 'initiative']);
      requireInput(group || !Object.hasOwn(patch, 'initiative'));
      for (const name of ['total', 'initiative'] as const) {
        if (Object.hasOwn(patch, name) && patch[name] !== null) timestamp(patch[name]);
      }
      return lifecycle.transaction(scope, (db) => {
        const previous = limits(db, scope);
        db.prepare(
          `INSERT INTO chat_token_budgets(chat_id,generation,total_limit,initiative_limit) VALUES(?,?,?,?)
           ON CONFLICT(chat_id,generation) DO UPDATE SET total_limit=excluded.total_limit,initiative_limit=excluded.initiative_limit`,
        ).run(
          scope.chatId,
          scope.generation,
          patch.total === undefined ? previous.total : patch.total,
          patch.initiative === undefined ? previous.initiative : patch.initiative,
        );
        return readBudget(db, scope, group, now);
      });
    },
    beginObservation(scope: ConnectionScope, now = Date.now()): MembershipObservation {
      timestamp(now);
      return lifecycle.transaction(scope, (db) => {
        const row = db
          .prepare(
            `INSERT INTO chat_token_budgets(chat_id,generation,observation) VALUES(?,?,1)
           ON CONFLICT(chat_id,generation) DO UPDATE SET observation=observation+1
           WHERE observation<9007199254740991 RETURNING observation`,
          )
          .get(scope.chatId, scope.generation) as { observation: number } | undefined;
        if (!row) throw new StorageError('operation_failed');
        db.prepare(
          `INSERT INTO participant_sync(chat_id,generation,last_attempt_at) VALUES(?,?,?)
          ON CONFLICT(chat_id,generation) DO UPDATE SET
          last_attempt_at=excluded.last_attempt_at,last_attempt_complete=NULL`,
        ).run(scope.chatId, scope.generation, now);
        return {
          chatId: scope.chatId,
          generation: scope.generation,
          number: row.observation,
          startedAt: now,
          revision: participantSync(db, scope).revision,
          connectionRevision: lifecycle.assertScope(db, scope).revision,
        };
      });
    },
    finishObservation(
      scope: ConnectionScope,
      observation: MembershipObservation,
      membership: HumanMembership,
      now = Date.now(),
    ) {
      timestamp(now);
      if (membership.complete) {
        const { people, members } = membership;
        timestamp(people);
        requireInput(Number.isSafeInteger(people * tokensPerPerson) && people === members.length);
        const platform = scope.chatId.split(':')[0];
        const users = new Set(
          members.map(({ userId, role }) => {
            compositeId(userId);
            requireInput(
              userId.split(':')[0] === platform && ['member', 'admin', 'unknown'].includes(role),
            );
            return userId;
          }),
        );
        requireInput(users.size === people);
      }
      return lifecycle.transaction(scope, (db) => {
        if (
          observation.chatId !== scope.chatId ||
          observation.generation !== scope.generation ||
          lifecycle.assertScope(db, scope).revision !== observation.connectionRevision
        )
          return false;
        const current = db
          .prepare('SELECT observation FROM chat_token_budgets WHERE chat_id=? AND generation=?')
          .get(scope.chatId, scope.generation) as { observation: number } | undefined;
        const sync = participantSync(db, scope);
        if (
          current?.observation !== observation.number ||
          sync.lastAttemptAt !== observation.startedAt ||
          sync.lastAttemptComplete !== null
        )
          return false;
        if (!membership.complete || sync.revision !== observation.revision) {
          db.prepare(
            'UPDATE participant_sync SET last_attempt_complete=0,needs_sync=1 WHERE chat_id=? AND generation=?',
          ).run(scope.chatId, scope.generation);
          return false;
        }

        const at = Math.max(now, observation.startedAt);
        if (membership.people > 0 && !chats.get(scope.chatId))
          chats.create(scope.chatId, { responseMode: 'normal', enabled: true, createdAt: at });
        applyParticipantSnapshot(db, scope, membership.members, at, observation.startedAt);
        db.prepare('UPDATE chat_token_budgets SET people=? WHERE chat_id=? AND generation=?').run(
          membership.people,
          scope.chatId,
          scope.generation,
        );
        db.prepare(
          `UPDATE participant_sync SET last_attempt_complete=1,last_complete_started_at=?,
          last_complete_at=?,needs_sync=0 WHERE chat_id=? AND generation=?`,
        ).run(observation.startedAt, at, scope.chatId, scope.generation);
        return true;
      });
    },
    reserve(scope: ConnectionScope, group: boolean, attempt: TokenReservation, now: number) {
      return lifecycle.transaction(scope, (db) => {
        if (!canReserveTokens(db, scope, group, attempt, now)) return false;
        insertTokenReservation(db, scope, attempt, now);
        return true;
      });
    },
    reconcile(scope: ConnectionScope, key: string, usage: LlmUsage) {
      return lifecycle.transaction(scope, (db) => reconcileTokenReservation(db, scope, key, usage));
    },
  };
}

const stores = new WeakMap<object, ReturnType<typeof createTokenBudgetStore>>();
export function registerTokenBudgets(
  storage: object,
  store: ReturnType<typeof createTokenBudgetStore>,
) {
  stores.set(storage, store);
}

export function tokenBudgetStore(storage: object) {
  const store = stores.get(storage);
  if (!store) throw new StorageError('invalid_input');
  return store;
}
