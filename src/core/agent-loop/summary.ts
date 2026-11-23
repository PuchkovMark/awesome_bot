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
export function createAttemptSummary() {
  let attempts = 0;
  const perStep: number[] = [];
  const input = counter(),
    output = counter();
  return {
    beginAttempt(step = 0) {
      perStep[step] = (perStep[step] ?? 0) + 1;
      attempts++;
      input.begin();
      output.begin();
    },
    cancelAttempt(step = 0) {
      perStep[step]!--;
      if (perStep.at(-1) === 0) perStep.pop();
      attempts--;
      input.cancel();
      output.cancel();
    },
    recordUsage(usage: { readonly input: unknown; readonly output: unknown }) {
      input.record(usage.input);
      output.record(usage.output);
    },
    snapshot(
      durationMs: number,
      helperSteps: ReadonlyArray<readonly { input: number | null; output: number | null }[]> = [],
    ): AgentLoopSummary {
      const helpers = helperSteps.flat();
      const helperTotals = (which: 'input' | 'output', base: TokenCounter): TokenCounter => {
        let { knownTokens, unknownAttempts, overflowed } = base;
        for (const h of helpers) {
          const n = usageCount(h[which]);
          if (n === null) unknownAttempts++;
          else if (knownTokens !== null) {
            if (n > Number.MAX_SAFE_INTEGER - knownTokens) {
              knownTokens = null;
              overflowed = true;
            } else knownTokens += n;
          }
        }
        return Object.freeze({ knownTokens, unknownAttempts, overflowed });
      };
      return Object.freeze({
        steps: perStep.length + helperSteps.length,
        attempts: attempts + helpers.length,
        attemptsPerStep: Object.freeze([...perStep, ...helperSteps.map((step) => step.length)]),
        durationMs,
        usage: Object.freeze({
          input: helperTotals('input', input.snapshot()),
          output: helperTotals('output', output.snapshot()),
        }),
      });
    },
  };
}
