import { expect, test } from 'vitest';
import { scenarios } from '../src/evals/scenarios';

test('сценарии имеют уникальные ключи сравнения и шаги проверки в VK', () => {
  expect(scenarios.map(scenario => scenario.id)).toEqual([
    'limited-history', 'untrusted-current', 'untrusted-name', 'untrusted-history', 'untrusted-reply', 'ordinary-direct', 'ordinary-reply',
  ]);
  for (const scenario of scenarios) {
    expect(scenario.id).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
    expect(scenario.revision).toBeGreaterThan(0);
    expect(scenario.vkSteps.join('\n')).toContain(scenario.input.text);
    expect(new Set(scenario.criteria.map(criterion => criterion.id)).size).toBe(scenario.criteria.length);
    expect(scenario.criteria.some(criterion => criterion.vk)).toBe(true);
  }
});
