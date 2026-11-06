import assert from 'node:assert/strict';
import test from 'node:test';
import type { AIMessage, AIProvider, AIResponse } from '../src/services/ai/AIProvider.js';
import { findWebSearchQuery } from '../src/services/search/searchIntentService.js';

class MockAIProvider implements AIProvider {
  readonly name = 'mock';

  constructor(private readonly content: string) {}

  async send(_messages: AIMessage[]): Promise<AIResponse> {
    return { content: this.content };
  }
}

test('web search intent returns a generated query when current information is needed', async () => {
  const query = await findWebSearchQuery(
    new MockAIProvider('{"search_query":"сравнение ставок по вкладам в банках России"}'),
    'Пенек, в каком банке самый выгодный процент по вкладам?',
  );

  assert.equal(query.query, 'сравнение ставок по вкладам в банках России');
});

test('web search intent skips search when the model says it is unnecessary', async () => {
  const query = await findWebSearchQuery(
    new MockAIProvider('{"search_query":null}'),
    'Объясни, что такое сложный процент.',
  );

  assert.equal(query.query, undefined);
});

test('web search intent rejects malformed or oversized search queries', async () => {
  assert.equal(
    (await findWebSearchQuery(new MockAIProvider('не JSON'), 'Найди новости')).query,
    undefined,
  );
  assert.equal(
    (
      await findWebSearchQuery(
        new MockAIProvider(JSON.stringify({ search_query: 'x'.repeat(501) })),
        'Найди новости',
      )
    ).query,
    undefined,
  );
});
