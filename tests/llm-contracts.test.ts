import { expect, test } from 'vitest';
import { llmFailure } from '../src/llm/errors.js';
import type { LlmResult } from '../src/llm/index.js';

test('ошибка содержит только фиксированные безопасные поля', () => {
  expect(llmFailure('network')).toEqual({ kind: 'error', code: 'network', message: 'Ошибка соединения с провайдером.' });
  expect(Object.isFrozen(llmFailure('network'))).toBe(true);
});
test('контракт допускает непрозрачные аргументы и неизвестный usage', () => {
  const result: LlmResult = { kind: 'tool_calls', calls: [{ id: '1', name: 'lookup', arguments: '{не JSON' }], text: null, usage: { input: null, output: 0 } };
  expect(result.calls[0]?.arguments).toBe('{не JSON');
  expect(result.usage).toEqual({ input: null, output: 0 });
});
