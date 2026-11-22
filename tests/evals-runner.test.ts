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
