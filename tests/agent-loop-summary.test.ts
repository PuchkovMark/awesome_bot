import { expect, test } from 'vitest';
import { createAttemptSummary } from '../src/core/agent-loop/summary';
import { loopOptions } from '../src/core/agent-loop/validation';

test('шаги и попытки различаются, известный ноль отличается от неизвестного расхода', () => {
  const summary = createAttemptSummary();
  expect(summary.snapshot(0)).toMatchObject({ steps: 0, attempts: 0, attemptsPerStep: [], usage: { input: { knownTokens: 0, unknownAttempts: 0 } } });
  summary.beginAttempt(); summary.recordUsage({ input: 0, output: null });
  summary.beginAttempt(); summary.recordUsage({ input: 5, output: 3 });
  const result = summary.snapshot(2);
  expect(result).toMatchObject({ steps: 1, attempts: 2, attemptsPerStep: [2], usage: {
    input: { knownTokens: 5, unknownAttempts: 0, overflowed: false }, output: { knownTokens: 3, unknownAttempts: 1, overflowed: false },
  } });
  summary.beginAttempt(); expect(result.attempts).toBe(2); expect(Object.isFrozen(result.attemptsPerStep)).toBe(true);
});
test.each([-1, 1.5, Infinity, NaN, '3', undefined])('некорректный usage %s остаётся неизвестным', (value) => {
  const summary = createAttemptSummary(); summary.beginAttempt(); summary.recordUsage({ input: value, output: 0 });
  expect(summary.snapshot(0).usage).toEqual({ input: { knownTokens: 0, unknownAttempts: 1, overflowed: false }, output: { knownTokens: 0, unknownAttempts: 0, overflowed: false } });
});
test('переполнение известных токенов помечается, а не превращается в точное число', () => {
  const summary = createAttemptSummary(); summary.beginAttempt(); summary.recordUsage({ input: Number.MAX_SAFE_INTEGER, output: null });
  summary.beginAttempt(); summary.recordUsage({ input: 1, output: null });
  expect(summary.snapshot(0).usage.input).toEqual({ knownTokens: null, overflowed: true, unknownAttempts: 0 });
});
test.each([{ maxSteps: 0 }, { maxAttemptsPerStep: 0 }, { timeoutMs: 2_147_483_648 }, { retryDelayMs: -1 }, { retryServerErrors: 'true' }, { retryErrors: ['rate_limit'] }])('неверная конфигурация безопасно отклоняется', (options) => {
  expect(() => loopOptions(options as never)).toThrow('Некорректная конфигурация агентного цикла.');
});
