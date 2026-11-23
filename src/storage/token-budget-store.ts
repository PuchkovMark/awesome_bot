import type { Database } from 'better-sqlite3';
import type { ConnectionScope } from '../contracts/index';
import type { LlmUsage } from '../llm/types';
import type { LifecycleBackend } from './lifecycle-store';
import { StorageError } from './errors';
import { object, requireInput, timestamp } from './validation';

export const tokenBudgetWindowMs = 86_400_000;
const tokensPerPerson = 15_000;

export interface TokenReservation {
  readonly key: string;
  readonly purpose: 'direct' | 'initiative';
  readonly input: number;
  readonly output: number;
}
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

function limits(db: Database, scope: ConnectionScope): Limits {
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

function readBudget(db: Database, scope: ConnectionScope, group: boolean, now: number) {
  timestamp(now);
  const settings = limits(db, scope);
  const total: Spending = { confirmed: 0n, reserved: 0n, incompleteAttempts: 0 };
  const initiative: Spending = { ...total };
  for (const attempt of db
    .prepare(
      `SELECT purpose,input_reserve AS inputReserve,output_reserve AS outputReserve,
            input_tokens AS inputTokens,output_tokens AS outputTokens
       FROM token_budget_attempts WHERE chat_id=? AND generation=? AND admitted_at>? AND admitted_at<=?`,
    )
    .iterate(scope.chatId, scope.generation, now - tokenBudgetWindowMs, now) as Iterable<Attempt>) {
    addUsage(total, attempt);
    if (attempt.purpose === 'initiative') addUsage(initiative, attempt);
  }
  return {
    period: { from: now - tokenBudgetWindowMs, through: now },
    people: group ? settings.people : null,
    total: balance(
      settings.total ?? (group ? (settings.people ?? 1) * tokensPerPerson : 500_000),
      total,
    ),
    initiative: group ? balance(settings.initiative ?? 10_000, initiative) : null,
  };
}

export function canReserveTokens(
  db: Database,
  scope: ConnectionScope,
  group: boolean,
  attempt: TokenReservation,
  now: number,
) {
  requireInput(
    typeof attempt.key === 'string' && attempt.key.length > 0 && attempt.key.length <= 256,
  );
  requireInput(attempt.purpose === 'direct' || attempt.purpose === 'initiative');
  timestamp(attempt.input);
  timestamp(attempt.output);
  const current = readBudget(db, scope, group, now);
  const requested = BigInt(attempt.input) + BigInt(attempt.output);
  if (current.total.confirmed + current.total.reserved + requested > BigInt(current.total.limit))
    return false;
  if (
    attempt.purpose === 'initiative' &&
    (!current.initiative ||
      current.initiative.confirmed + current.initiative.reserved + requested >
        BigInt(current.initiative.limit))
  )
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

export function createTokenBudgetStore(lifecycle: LifecycleBackend) {
  return {
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
    beginObservation(scope: ConnectionScope): number {
      return lifecycle.transaction(scope, (db) => {
        const row = db
          .prepare(
            `INSERT INTO chat_token_budgets(chat_id,generation,observation) VALUES(?,?,1)
           ON CONFLICT(chat_id,generation) DO UPDATE SET observation=observation+1
           WHERE observation<9007199254740991 RETURNING observation`,
          )
          .get(scope.chatId, scope.generation) as { observation: number } | undefined;
        if (!row) throw new StorageError('operation_failed');
        return row.observation;
      });
    },
    confirmPeople(scope: ConnectionScope, observation: number, people: number) {
      timestamp(people);
      requireInput(Number.isSafeInteger(people * tokensPerPerson));
      return lifecycle.transaction(
        scope,
        (db) =>
          db
            .prepare(
              `UPDATE chat_token_budgets SET people=? WHERE chat_id=? AND generation=? AND observation=?`,
            )
            .run(people, scope.chatId, scope.generation, observation).changes === 1,
      );
    },
    reserve(scope: ConnectionScope, group: boolean, attempt: TokenReservation, now: number) {
      return lifecycle.transaction(scope, (db) => {
        if (!canReserveTokens(db, scope, group, attempt, now)) return false;
        insertTokenReservation(db, scope, attempt, now);
        return true;
      });
    },
    reconcile(scope: ConnectionScope, key: string, usage: LlmUsage) {
      if (usage.input !== null) timestamp(usage.input);
      if (usage.output !== null) timestamp(usage.output);
      return lifecycle.transaction(
        scope,
        (db) =>
          db
            .prepare(
              `UPDATE token_budget_attempts
           SET input_tokens=coalesce(input_tokens,?),output_tokens=coalesce(output_tokens,?)
           WHERE chat_id=? AND generation=? AND attempt_key=?`,
            )
            .run(usage.input, usage.output, scope.chatId, scope.generation, key).changes === 1,
      );
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
