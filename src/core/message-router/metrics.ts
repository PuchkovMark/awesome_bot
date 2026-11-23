import type { SafeLogger } from '../../logger/types';
import type { RoutingDecision } from './types';
export function createRouterMetrics(logger?: SafeLogger) {
  let unknown = 0;
  const silence = { reply_other: 0, reply_unknown: 0, mention_flood: 0 };
  return Object.freeze({
    record(decision: RoutingDecision) {
      const { reason } = decision;
      if (reason === 'reply_other' || reason === 'reply_unknown' || reason === 'mention_flood') {
        silence[reason] = Math.min(Number.MAX_SAFE_INTEGER, silence[reason] + 1);
        try {
          logger?.event({ event: 'router_silence', reason, count: silence[reason] }, 'info');
        } catch {
          /* Диагностика не меняет решение. */
        }
        return;
      }
      if (reason !== 'sender_unknown') return;
      unknown = Math.min(Number.MAX_SAFE_INTEGER, unknown + 1);
      try {
        logger?.event({ event: 'router_stats', window: 'run', senderUnknown: unknown }, 'info');
      } catch {
        /* Логгер не меняет решение. */
      }
    },
    snapshot() {
      return Object.freeze({ senderUnknown: unknown });
    },
  });
}
