import type { AuthorizationStore } from '../../storage/index.js';

export interface AuthorizationScheduler {
  schedule(delayMs: number, callback: () => void): () => void;
}
const defaultScheduler: AuthorizationScheduler = {
  schedule(delay, callback) {
    // Ограничение Node.js, не продуктовый срок хранения.
    const timer = setTimeout(callback, Math.min(delay, 2_147_483_647));
    timer.unref(); return () => clearTimeout(timer);
  },
};
export function createReasonMaintenance(store: Pick<AuthorizationStore,'pruneReasons'>, retentionMs: number, now: () => number,
  scheduler: AuthorizationScheduler = defaultScheduler) {
  let cancel: (() => void) | undefined;
  let stopped = false;
  let nextAt: number | null = null;
  let error: 'maintenance_failed' | null = null;
  function notify(revokedAt: number) {
    if (stopped) return;
    const deadline = revokedAt + retentionMs;
    nextAt = nextAt === null ? deadline : Math.min(nextAt, deadline);
    cancel?.();
    cancel = scheduler.schedule(Math.max(0, nextAt - now()), () => { void run().catch(() => { /* Статус ошибки доступен вызывающему компоненту. */ }); });
  }
  async function run() {
    if (stopped) throw new Error('Authorization: maintenance_stopped');
    cancel?.(); cancel = undefined; nextAt = null;
    try {
      const result = await store.pruneReasons(now(), retentionMs);
      error = null;
      if (result.nextRevokedAt !== null && !stopped) notify(result.nextRevokedAt);
      return result;
    } catch {
      error = 'maintenance_failed';
      throw new Error('Authorization: maintenance_failed');
    }
  }
  return {
    run, notify,
    status: () => Object.freeze({ stopped, nextAt, error }),
    stop() { stopped = true; cancel?.(); cancel = undefined; nextAt = null; },
  };
}
