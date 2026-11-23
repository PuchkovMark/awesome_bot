import type { AgentLoopSummary, TokenCounter } from './types';

export function usageCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function counter() {
  let knownTokens: number | null = 0,
    unknownAttempts = 0,
    overflowed = false;
  return {
    begin() {
      unknownAttempts++;
    },
    cancel() {
      unknownAttempts--;
    },
    record(value: unknown) {
      const count = usageCount(value);
      if (count === null) return;
      unknownAttempts--;
      if (knownTokens !== null) {
        if (count > Number.MAX_SAFE_INTEGER - knownTokens) {
          knownTokens = null;
          overflowed = true;
        } else knownTokens += count;
      }
    },
    snapshot(): TokenCounter {
      return Object.freeze({ knownTokens, unknownAttempts, overflowed });
    },
  };
}
/** В текстовой версии есть только один логический шаг, сколько бы ни было попыток. */
export function createAttemptSummary() {
  let attempts = 0;
  const input = counter(),
    output = counter();
  return {
    beginAttempt() {
      attempts++;
      input.begin();
      output.begin();
    },
    cancelAttempt() {
      attempts--;
      input.cancel();
      output.cancel();
    },
    recordUsage(usage: { readonly input: unknown; readonly output: unknown }) {
      input.record(usage.input);
      output.record(usage.output);
    },
    snapshot(durationMs: number): AgentLoopSummary {
      return Object.freeze({
        steps: attempts === 0 ? 0 : 1,
        attempts,
        attemptsPerStep: Object.freeze(attempts === 0 ? [] : [attempts]),
        durationMs,
        usage: Object.freeze({ input: input.snapshot(), output: output.snapshot() }),
      });
    },
  };
}
