import { expect, test, vi } from 'vitest';
import { createLlmSessionId } from '../src/llm/index';
import type { ConnectionScope } from '../src/contracts/lifecycle';

// Синтетическая область: функция не является проверкой актуальности подключения.
const scope = (chatId: string, generation: number) => ({ chatId, generation }) as ConnectionScope;
test('сессия воспроизводима без хранения и различает область/секрет', () => {
  const create = createLlmSessionId('synthetic-secret');
  const id = create(scope('vk:example-chat', 1));
  expect(id).toMatch(/^[a-f0-9]{64}$/);
  expect(id).not.toContain('vk:example-chat');
  expect(id).not.toContain('synthetic-secret');
  expect(createLlmSessionId('synthetic-secret')(scope('vk:example-chat', 1))).toBe(id);
  expect(new Set([id, create(scope('vk:other-chat', 1)), create(scope('vk:example-chat', 2)),
    createLlmSessionId('other-secret')(scope('vk:example-chat', 1))]).size).toBe(4);
  expect(create(scope('vk:a1', 2))).not.toBe(create(scope('vk:a', 12)));
});
test('проверка входа не включает секрет или область в ошибку', () => {
  expect(() => createLlmSessionId(' ')).toThrow('Некорректный секрет сессии LLM.');
  const create = createLlmSessionId('secret');
  for (const invalid of [null, {}, scope('SECRET CHAT', 1), scope('vk:x', NaN), scope('vk:x', 0), scope('vk:x', 1.5)]) {
    expect(() => create(invalid as ConnectionScope)).toThrow('Некорректная область сессии LLM.');
  }
});
test('вычисление не вызывает сеть и не создаёт таймеров', () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw Error('network'); });
  const timer = vi.spyOn(globalThis, 'setTimeout');
  try {
    createLlmSessionId('secret')(scope('vk:a', 1));
    expect(fetch).not.toHaveBeenCalled(); expect(timer).not.toHaveBeenCalled();
  } finally { fetch.mockRestore(); timer.mockRestore(); }
});
