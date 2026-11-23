import { summaryFactChecks } from '../src/evals/chat-summaries';
import { expect, test } from 'vitest';
import { runScenario } from '../src/evals/runner';
import { historySearchScenarios, scenarios, yesterdayScenario } from '../src/evals/scenarios';

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
    'address-chosen',
    'address-namesake',
    'address-reset',
    'address-neighbor',
    'address-given-name',
    'address-empty',
    'address-neutral',
    'address-hidden',
    'address-literal',
    'initiative-help',
    'initiative-mention',
    'initiative-question',
    'initiative-other-address',
    'initiative-other-reply',
    'initiative-quoted-name',
    'initiative-sensitive',
    'initiative-bot',
    'initiative-unknown',
    'initiative-normal',
    'initiative-silent',
    'passport-local-glossary',
    'passport-untrusted-grant',
    'history-yesterday',
    'history-search-found',
    'history-search-empty',
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

test('исходы поиска сравниваются на одном вопросе, промпте и недавнем окне', () => {
  const [found, empty] = historySearchScenarios;
  expect(found?.history).toMatchObject([
    { text: 'Встреча у фонтана.' },
    { text: 'Открыли дверь.' },
  ]);
  expect(empty?.history).toMatchObject([{ text: 'Закрыли окно.' }, { text: 'Открыли дверь.' }]);
  expect(new Set(historySearchScenarios.map(({ input }) => input.chatId)).size).toBe(2);
  for (const scenario of historySearchScenarios) {
    expect(scenario).toMatchObject({
      promptKey: 'history-search-completeness',
      prompt: found!.prompt,
      input: { text: found!.input.text, timestamp: found!.input.timestamp },
      historyTimezone: 'Europe/Moscow',
      historyLimit: 1,
    });
    expect(scenario.history.map(({ timestamp }) => timestamp)).toEqual(
      found!.history.map(({ timestamp }) => timestamp),
    );
  }
});

test('оценки самостоятельных реплик отделяют лишнее вступление от пропуска', () => {
  const selected = scenarios.filter(({ initiative }) => initiative);
  const positive = selected.filter(({ criteria }) =>
    criteria.some(({ id }) => id === 'initiative-start'),
  );
  const negative = selected.filter(({ criteria }) =>
    criteria.some(({ id }) => id === 'initiative-silence'),
  );
  expect(positive).toHaveLength(3);
  expect(negative.length).toBeGreaterThan(positive.length);
  for (const scenario of positive)
    expect(
      scenario.criteria[0]!.check({ request: null, answer: null, historyTruncated: false }),
    ).toBe(false);
  for (const scenario of negative)
    expect(
      scenario.criteria[0]!.check({
        request: null,
        answer: null,
        historyTruncated: false,
        initiativeCandidate: true,
      }),
    ).toBe(false);
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

test('оценки обращений передают выбор только его владельцу и проверяют ответ на его реплику', () => {
  const own = scenarios.find(({ id }) => id === 'address-chosen')!;
  const other = scenarios.find(({ id }) => id === 'address-namesake')!;
  const hidden = scenarios.find(({ id }) => id === 'address-hidden')!;
  expect(own.input.userId).toBe(own.address?.preference?.owner);
  expect(other.address?.preference).toEqual(own.address?.preference);
  expect(other.input.userId).not.toBe(own.input.userId);
  expect(other.input.authorName).toBe(own.input.authorName);
  expect(own.answer).toBe('Рысь, вы предложили фонтан.');
  expect(other.answer).toBe('Саша Иванов, вы предложили маяк.');
  expect(hidden.address?.preference).toMatchObject({ state: 'hidden' });
  expect(hidden.answer).not.toContain(hidden.address?.preference?.form);
  expect(
    new Set(scenarios.filter(({ address }) => address).map(({ promptKey }) => promptKey)),
  ).toEqual(new Set(['f52-address-preferences']));
});

test.each([
  ['2026-03-30T00:15:00+02:00', '2026-03-28T23:00:00Z', '2026-03-29T22:00:00Z', 23],
  ['2026-10-26T00:15:00+01:00', '2026-10-24T22:00:00Z', '2026-10-25T23:00:00Z', 25],
] as const)('вчерашний период учитывает смену смещения %s', async (now, from, to, hours) => {
  expect(Date.parse(to) - Date.parse(from)).toBe(hours * 3600000);
  const scenario = yesterdayScenario('history-dst', 'Europe/Berlin', now, from, to);
  expect(await runScenario(scenario)).toMatchObject({ outcome: 'passed' });
});

test('оценка пересказа различает автора обещания и направление переноса', () => {
  expect(
    summaryFactChecks('Зал Б. Ира принесёт ключ. Встреча перенесена с 27 на 28 ноября.').map(
      (c) => c.matches,
    ),
  ).toEqual([true, true, true]);
  expect(
    summaryFactChecks(
      'Зал Б. Ключ принесёт Лев. Ира выбрала дату. Встреча перенесена с 28 на 27 ноября.',
    ).map((c) => c.matches),
  ).toEqual([true, false, false]);
});
