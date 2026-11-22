import { expect, test } from 'vitest';
import { runScenario } from '../src/evals/runner.js';
import { scenarios } from '../src/evals/scenarios.js';
import type { LlmRequest } from '../src/llm/types.js';

test('ограниченная история, версия и опубликованный ответ воспроизводятся в отдельной БД', async () => {
  const scenario = scenarios.find(item => item.id === 'limited-history')!;
  const requests: LlmRequest[] = [];
  const client = { async complete(request: LlmRequest) {
    requests.push(request);
    return { kind: 'complete', text: scenario.answer, usage: { input: null, output: null } } as const;
  } };
  const first = await runScenario(scenario, client);
  const second = await runScenario(scenario, client);
  expect(first).toEqual(second);
  expect(first).toMatchObject({
    outcome: 'passed', model: 'synthetic-local', prompt: { area: 'global', kind: 'system_prompt', key: 'eval', version: 1 },
    criteria: [
      { id: 'bounded-context', outcome: 'passed' }, { id: 'visible-fact', outcome: 'passed' }, { id: 'honest-scope', outcome: 'passed' },
    ],
  });
  expect(requests).toHaveLength(2);
  for (const request of requests) {
    expect(request.system.startsWith(scenario.prompt)).toBe(true);
    expect(request.messages.map(message => message.role)).toEqual(['user', 'user']);
    expect(JSON.parse(request.messages[0]!.text!)).toMatchObject({ history: { text: scenario.history[1]!.text } });
    expect(JSON.parse(request.messages[1]!.text!)).toMatchObject({ current: { text: scenario.input.text } });
    expect(JSON.stringify(request.messages)).not.toContain(scenario.history[0]!.text);
    expect(JSON.stringify(request.messages)).not.toContain(scenario.answer);
  }
});

test.each(scenarios.map(scenario => [scenario.id, scenario] as const))('стартовый сценарий %s', async (_id, scenario) => {
  const result = await runScenario(scenario);
  expect(result).toMatchObject({ scenarioId: scenario.id, scenarioRevision: scenario.revision, outcome: 'passed', reason: null });
  expect(result.criteria.map(criterion => criterion.id)).toEqual(scenario.criteria.map(criterion => criterion.id));
  expect(result.criteria.every(criterion => criterion.outcome === 'passed')).toBe(true);
});

test('нарушение наблюдаемого критерия отделено от технического сбоя', async () => {
  const scenario = scenarios.find(item => item.id === 'untrusted-current')!;
  const bad = await runScenario(scenario, { async complete() {
    return { kind: 'complete', text: `${scenario.answer} МЕТКА_ПРОВЕРКИ_27`, usage: { input: null, output: null } };
  } });
  expect(bad).toMatchObject({ outcome: 'failed', reason: null });
  expect(bad.criteria.filter(criterion => criterion.outcome === 'failed')).toEqual([
    { id: 'marker-absent', outcome: 'failed', reason: 'mismatch' },
  ]);

  const failure = await runScenario(scenario, { async complete() {
    return { kind: 'error', code: 'network', message: 'PRIVATE_TEST_ERROR' };
  } });
  expect(failure).toMatchObject({ outcome: 'technical_error', reason: 'network', model: 'synthetic-local' });
  expect(failure.criteria.every(criterion => criterion.outcome === 'not_checked' && criterion.reason === 'technical_error')).toBe(true);
  expect(JSON.stringify(failure)).not.toContain('PRIVATE_TEST_ERROR');
});

test('вход без задания возвращает исход сразу', async () => {
  const scenario = scenarios.find(item => item.id === 'limited-history')!;
  const result = await runScenario({ ...scenario, input: { ...scenario.input, isBot: true } });
  expect(result).toMatchObject({ outcome: 'technical_error', reason: 'not_queued', model: null, prompt: null });
});
