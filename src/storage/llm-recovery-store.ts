import type { Database } from 'better-sqlite3';
import type {
  LlmAvailability,
  LlmRecovery,
  LlmRecoveryPermit,
  LlmRecoverySettings,
} from '../core/llm-recovery';
import type { LlmResult } from '../llm/types';

const maxDateMs = 8_640_000_000_000_000;
interface State {
  pausedUntil: number | null;
  delayMs: number;
  serverErrors: string;
  epoch: number;
  probeOwner: string | null;
}
function read(db: Database): State {
  return db
    .prepare(
      `SELECT paused_until AS pausedUntil,delay_ms AS delayMs,server_errors AS serverErrors,
      epoch,probe_owner AS probeOwner FROM llm_recovery WHERE singleton=1`,
    )
    .get() as State;
}

function save(db: Database, state: State) {
  db.prepare(
    `UPDATE llm_recovery SET paused_until=@pausedUntil,delay_ms=@delayMs,
    server_errors=@serverErrors,epoch=@epoch,probe_owner=@probeOwner WHERE singleton=1`,
  ).run(state);
}

function providerDeadline(result: LlmResult | undefined, now: number) {
  if (result?.kind !== 'error' || result.code !== 'rate_limit') return undefined;
  const { retryAt } = result;
  return retryAt !== undefined &&
    Number.isSafeInteger(retryAt) &&
    retryAt >= 0 &&
    retryAt <= maxDateMs
    ? Math.max(now, retryAt)
    : undefined;
}

function paused(state: State, until: number, delayMs: number): State {
  return {
    pausedUntil: until,
    delayMs,
    serverErrors: '[]',
    epoch: state.epoch + 1,
    probeOwner: null,
  };
}

export function createLlmRecoveryStore(
  transaction: <T>(fn: (db: Database) => T) => T,
  owner: string,
  settings: LlmRecoverySettings,
  now = () => Date.now(),
): LlmRecovery {
  const permits = new WeakSet<LlmRecoveryPermit>();
  const canSend = (state: State, at: number): LlmAvailability => {
    if (state.pausedUntil === null) return 'available';
    if (at < state.pausedUntil) return 'paused';
    return state.probeOwner === owner ? 'probing' : 'available';
  };
  const until = (at: number, delayMs: number) => Math.min(maxDateMs, at + delayMs);
  return {
    availability() {
      return transaction((db) => canSend(read(db), now()));
    },
    begin() {
      const permit = transaction((db) => {
        const state = read(db);
        if (canSend(state, now()) !== 'available') return null;
        const probe = state.pausedUntil !== null;
        if (probe) save(db, { ...state, probeOwner: owner });
        return Object.freeze({ epoch: state.epoch, probe });
      });
      if (permit) permits.add(permit);
      return permit;
    },
    finish(permit, result) {
      if (!permits.delete(permit)) return;
      transaction((db) => {
        const state = read(db);
        const at = now();
        const failure = result?.kind === 'error' ? result.code : undefined;
        const retry = providerDeadline(result, at);
        if (permit.epoch !== state.epoch) {
          // Срок провайдера может продлить паузу, открытую другим вызовом.
          if (failure === 'rate_limit' && state.pausedUntil === null)
            save(
              db,
              paused(state, retry ?? until(at, settings.initialPauseMs), settings.initialPauseMs),
            );
          else if (
            retry !== undefined &&
            state.pausedUntil !== null &&
            retry > Math.max(at, state.pausedUntil)
          )
            save(db, { ...state, pausedUntil: retry });
          return;
        }
        if (permit.probe) {
          if (state.probeOwner !== owner) return;
          const pausedUntil = state.pausedUntil ?? at;
          if (failure === 'server' || failure === 'rate_limit') {
            const delayMs = Math.min(settings.maxPauseMs, state.delayMs * 2);
            save(db, paused(state, Math.max(pausedUntil, until(at, delayMs), retry ?? 0), delayMs));
          } else if (result && result.kind !== 'error' && at >= pausedUntil) {
            save(db, {
              pausedUntil: null,
              delayMs: 0,
              serverErrors: '[]',
              epoch: state.epoch + 1,
              probeOwner: null,
            });
          } else save(db, { ...state, probeOwner: null });
          return;
        }
        if (failure === 'rate_limit') {
          save(
            db,
            paused(state, retry ?? until(at, settings.initialPauseMs), settings.initialPauseMs),
          );
        } else if (failure === 'server') {
          const errors = (JSON.parse(state.serverErrors) as number[]).filter(
            (time) => time <= at && at - time < settings.failureWindowMs,
          );
          errors.push(at);
          if (errors.length >= settings.failureThreshold)
            save(db, paused(state, until(at, settings.initialPauseMs), settings.initialPauseMs));
          else save(db, { ...state, serverErrors: JSON.stringify(errors) });
        } else if (
          result &&
          state.serverErrors !== '[]' &&
          failure !== 'network' &&
          failure !== 'timeout' &&
          failure !== 'cancelled'
        ) {
          save(db, { ...state, serverErrors: '[]' });
        }
      });
    },
  };
}
