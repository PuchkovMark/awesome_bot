import type { LlmResult } from '../llm/types';
import type { LlmAvailability, LlmRecovery } from './llm-recovery';

export const llmAdmissionDefaults = Object.freeze({ parallel: 4, background: 1, waitMs: 10_000 });

export interface LlmAdmissionSettings {
  readonly parallel: number;
  readonly background: number;
  readonly waitMs: number;
}

interface CallLifetime {
  readonly signal: AbortSignal;
  /** Общий сигнал пользовательского задания, в том числе у его помощников. */
  readonly jobSignal?: AbortSignal;
  readonly deadline?: number;
  readonly waitDeadline?: number;
  readonly current: () => boolean;
}

export type SendLlmCall = (
  invoke: () => Promise<LlmResult>,
  cancelBeforeSend?: () => void,
) => Promise<LlmResult>;
type Prepare<T> = (send: SendLlmCall) => T;
type NotSent = 'cancelled' | 'llm_wait_timeout';
export type LlmAdmissionEvent = 'rate_limit' | 'llm_wait_timeout' | 'llm_provider_paused';
class LlmCallNotSent extends Error {
  readonly kind: NotSent;
  constructor(kind: NotSent) {
    super(kind);
    this.kind = kind;
  }
}
type Admission<T> =
  | { readonly kind: 'ready'; readonly value: T }
  | { readonly kind: 'cancelled' | 'llm_wait_timeout' | 'llm_provider_paused' | 'background_busy' };

export type LlmAdmission = ReturnType<typeof createLlmAdmission>;

export async function scheduleLlmCall<T>(
  admission: LlmAdmission | undefined,
  lifetime: CallLifetime,
  prepare: Prepare<T>,
  kind: 'direct' | 'background' = 'direct',
): Promise<Admission<T>> {
  if (admission) return admission[kind](lifetime, prepare);
  return lifetime.signal.aborted || !lifetime.current()
    ? { kind: 'cancelled' }
    : { kind: 'ready', value: prepare((invoke) => invoke()) };
}

export function createLlmAdmission(
  settings: LlmAdmissionSettings = llmAdmissionDefaults,
  now = () => performance.now(),
  recovery?: () => LlmRecovery | undefined,
  onEvent?: (outcome: LlmAdmissionEvent) => void,
) {
  const waiting = new Set<(availability: LlmAvailability) => void>();
  const releaseListeners = new Set<() => void>();
  const reportedForJob = {
    llm_wait_timeout: new WeakSet<AbortSignal>(),
    llm_provider_paused: new WeakSet<AbortSignal>(),
  };
  let active = 0;
  let background = 0;
  let preparing = false;
  let draining = false;
  const waitUntil = (deadline = Infinity) => Math.min(now() + settings.waitMs, deadline);
  const availability = () => recovery?.()?.availability() ?? 'available';
  const denied = ({ signal, current }: CallLifetime, until: number): NotSent | undefined =>
    signal.aborted || !current() ? 'cancelled' : now() >= until ? 'llm_wait_timeout' : undefined;

  function report(outcome: LlmAdmissionEvent) {
    try {
      onEvent?.(outcome);
    } catch {
      /* Диагностика не меняет исход вызова. */
    }
  }

  function drain() {
    if (preparing || draining) return;
    draining = true;
    try {
      while (waiting.size) {
        const state = availability();
        if (state === 'probing' || (state === 'available' && active >= settings.parallel)) break;
        waiting.values().next().value?.(state);
      }
    } finally {
      draining = false;
    }
  }

  function admit<T>(
    kind: 'direct' | 'background',
    prepare: Prepare<T>,
    lifetime: CallLifetime,
  ): Admission<T> {
    preparing = true;
    let canSend = true;
    let dispatched = false;
    const provider = recovery?.();
    let permit: ReturnType<LlmRecovery['begin']> = null;
    try {
      if (provider) {
        permit = provider.begin();
        if (!permit)
          return {
            kind: provider.availability() === 'stopped' ? 'cancelled' : 'llm_provider_paused',
          };
      }
      const value = prepare((invoke, cancelBeforeSend) => {
        if (!canSend) throw new Error('Отправка модели уже начата.');
        canSend = false;
        let interruption: NotSent | undefined;
        try {
          interruption = denied(lifetime, lifetime.deadline ?? Infinity);
        } catch (error) {
          cancelBeforeSend?.();
          throw error;
        }
        if (interruption) {
          cancelBeforeSend?.();
          throw new LlmCallNotSent(interruption);
        }
        dispatched = true;
        active++;
        if (kind === 'background') background++;
        const release = (result?: LlmResult) => {
          try {
            if (permit) provider!.finish(permit, result);
          } finally {
            if (result?.kind === 'error' && result.code === 'rate_limit') report('rate_limit');
            active--;
            if (kind === 'background') background--;
            drain();
            for (const notify of releaseListeners) notify();
          }
        };
        try {
          return invoke().then(
            (result) => {
              release(result);
              return result;
            },
            (error: unknown) => {
              release();
              throw error;
            },
          );
        } catch (error) {
          release();
          throw error;
        }
      });
      return { kind: 'ready', value };
    } catch (error) {
      if (error instanceof LlmCallNotSent) return { kind: error.kind };
      throw error;
    } finally {
      canSend = false;
      preparing = false;
      if (permit && !dispatched) provider!.finish(permit, undefined);
    }
  }

  return {
    stats: () => ({ active, background, waiting: waiting.size }),
    onRelease(notify: () => void) {
      releaseListeners.add(notify);
      return () => {
        releaseListeners.delete(notify);
      };
    },
    waitUntil,
    direct<T>(lifetime: CallLifetime, prepare: Prepare<T>): Promise<Admission<T>> {
      const { signal, jobSignal } = lifetime;
      const deadline = lifetime.deadline ?? Infinity;
      const until = waitUntil(Math.min(deadline, lifetime.waitDeadline ?? Infinity));
      return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const settle = (result: Admission<T>) => {
          if (
            jobSignal &&
            (result.kind === 'llm_wait_timeout' || result.kind === 'llm_provider_paused')
          ) {
            const reported = reportedForJob[result.kind];
            if (!reported.has(jobSignal)) {
              reported.add(jobSignal);
              report(result.kind);
            }
          }
          resolve(result);
        };
        const waitedUntilDeadline = () => timer !== undefined && now() >= until;
        const cleanup = () => {
          if (!waiting.delete(run)) return false;
          clearTimeout(timer);
          signal.removeEventListener('abort', cancel);
          return true;
        };
        const cancel = () => {
          if (cleanup()) settle({ kind: waitedUntilDeadline() ? 'llm_wait_timeout' : 'cancelled' });
        };
        const expire = () => {
          const remaining = until - now();
          if (remaining > 0) timer = setTimeout(expire, Math.ceil(remaining));
          else if (cleanup()) settle({ kind: 'llm_wait_timeout' });
        };
        const run = (state: LlmAvailability) => {
          if (!cleanup()) return;
          try {
            const interruption = waitedUntilDeadline()
              ? 'llm_wait_timeout'
              : denied(lifetime, deadline);
            if (interruption) settle({ kind: interruption });
            else if (state === 'stopped') settle({ kind: 'cancelled' });
            else if (state === 'paused') settle({ kind: 'llm_provider_paused' });
            else settle(admit('direct', prepare, lifetime));
          } catch (error) {
            reject(error);
          }
        };
        waiting.add(run);
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
        else drain();
        if (waiting.has(run)) expire();
      });
    },
    background<T>(lifetime: CallLifetime, prepare: Prepare<T>): Admission<T> {
      const interruption = denied(lifetime, lifetime.deadline ?? Infinity);
      if (interruption) return { kind: interruption };
      const state = availability();
      if (state === 'stopped') return { kind: 'cancelled' };
      if (state === 'paused') return { kind: 'llm_provider_paused' };
      if (
        state === 'probing' ||
        preparing ||
        draining ||
        waiting.size ||
        active >= settings.parallel ||
        background >= settings.background
      )
        return { kind: 'background_busy' };
      try {
        return admit('background', prepare, lifetime);
      } finally {
        drain();
      }
    },
  };
}
