import type { LlmResult } from '../llm/types';

export const llmAdmissionDefaults = Object.freeze({ parallel: 4, background: 1, waitMs: 10_000 });

export interface LlmAdmissionSettings {
  readonly parallel: number;
  readonly background: number;
  readonly waitMs: number;
}

interface CallLifetime {
  readonly signal: AbortSignal;
  readonly deadline?: number;
  readonly current: () => boolean;
}

export type SendLlmCall = (invoke: () => Promise<LlmResult>) => Promise<LlmResult>;
type Prepare<T> = (send: SendLlmCall) => T;
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
) {
  const waiting = new Set<() => void>();
  const releaseListeners = new Set<() => void>();
  let active = 0;
  let background = 0;
  let preparing = false;
  let draining = false;
  const waitUntil = (deadline = Infinity) => Math.min(now() + settings.waitMs, deadline);

  function drain() {
    if (preparing || draining) return;
    draining = true;
    try {
      while (active < settings.parallel && waiting.size) waiting.values().next().value!();
    } finally {
      draining = false;
    }
  }

  function admit<T>(kind: 'direct' | 'background', prepare: Prepare<T>): T {
    preparing = true;
    let canSend = true;
    try {
      return prepare((invoke) => {
        if (!canSend) throw new Error('Отправка модели уже начата.');
        canSend = false;
        active++;
        if (kind === 'background') background++;
        const release = () => {
          active--;
          if (kind === 'background') background--;
          drain();
          for (const notify of releaseListeners) notify();
        };
        try {
          return invoke().finally(release);
        } catch (error) {
          release();
          throw error;
        }
      });
    } finally {
      canSend = false;
      preparing = false;
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
      const { signal, current } = lifetime;
      const until = waitUntil(lifetime.deadline);
      return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => {
          if (!waiting.delete(run)) return false;
          clearTimeout(timer);
          signal.removeEventListener('abort', cancel);
          return true;
        };
        const cancel = () => {
          if (cleanup()) resolve({ kind: 'cancelled' });
        };
        const expire = () => {
          const remaining = until - now();
          if (remaining > 0) timer = setTimeout(expire, Math.ceil(remaining));
          else if (cleanup()) resolve({ kind: 'llm_wait_timeout' });
        };
        const run = () => {
          if (!cleanup()) return;
          try {
            if (signal.aborted || !current()) resolve({ kind: 'cancelled' });
            else if (now() >= until) resolve({ kind: 'llm_wait_timeout' });
            else resolve({ kind: 'ready', value: admit('direct', prepare) });
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
      if (lifetime.signal.aborted || !lifetime.current()) return { kind: 'cancelled' };
      if (
        preparing ||
        draining ||
        waiting.size ||
        active >= settings.parallel ||
        background >= settings.background
      )
        return { kind: 'background_busy' };
      try {
        return { kind: 'ready', value: admit('background', prepare) };
      } finally {
        drain();
      }
    },
  };
}
