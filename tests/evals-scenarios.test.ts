import { expect, test } from 'vitest';
import { scenarios } from '../src/evals/scenarios';

test('сценарии имеют уникальные ключи сравнения и шаги проверки в VK', () => {
  expect(scenarios.map((scenario) => scenario.id)).toEqual([
    'limited-history',
    'untrusted-current',
    'untrusted-name',
    'untrusted-history',
    'untrusted-reply',
    'ordinary-direct',
    'ordinary-reply',
    'authors-first',
    'authors-second',
    'authors-quote',
    'authors-disclosure',
    'authors-publication-guard',
    'authors-given-name',
    'authors-empty-name',
    'authors-technical-reference',
  ]);
  for (const scenario of scenarios) {
    expect(scenario.id).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
    expect(scenario.revision).toBeGreaterThan(0);
    expect(scenario.vkSteps.join('\n')).toContain(scenario.input.text);
    expect(new Set(scenario.criteria.map((criterion) => criterion.id)).size).toBe(
      scenario.criteria.length,
    );
    expect(scenario.criteria.some((criterion) => criterion.vk)).toBe(true);
  }
});

test('сценарии тёзок используют одну версию инструкции и проверяют разные предложения', () => {
  const first = scenarios.find(({ id }) => id === 'authors-first')!;
  const second = scenarios.find(({ id }) => id === 'authors-second')!;
  expect(first.input.userId).not.toBe(second.input.userId);
  expect(first.input.authorName).toBe('Саша Иванов');
  expect(second.input.authorName).toBe(first.input.authorName);
  expect(first.answer).toBe('Саша Иванов, вы предложили фонтан.');
  expect(second.answer).toBe('Саша Иванов, вы предложили маяк.');
  expect(second.history).toContainEqual(
    expect.objectContaining({ role: 'assistant', text: first.answer }),
  );
  const authors = scenarios.filter(({ id }) => id.startsWith('authors-'));
  expect(
    new Set(authors.map(({ prompt, promptKey }) => JSON.stringify([prompt, promptKey]))).size,
  ).toBe(1);
  expect(first.prompt).toContain('authorLabel');
});
