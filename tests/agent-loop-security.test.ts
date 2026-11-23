import { afterEach, expect, test, vi } from 'vitest';
import { createAgentLoop } from '../src/core/index';
import { agentInput, failure, response, sequence } from './helpers/agent-loop';

afterEach(() => {
  vi.restoreAllMocks();
});
test('ошибка и сводка не сериализуют произвольные поля клиента', async () => {
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const logs = methods.map((key) => vi.spyOn(console, key).mockImplementation(() => {}));
  const value = {
    ...failure('network'),
    message: 'PRIVATE_CONTEXT',
    stack: 'PRIVATE_STACK',
    cause: { authorization: 'PRIVATE_KEY' },
    raw: { sessionId: 'PRIVATE_SESSION' },
  };
  const result = await sequence([value]).loop.run(
    agentInput({ system: 'PRIVATE_CONTEXT', sessionId: 'PRIVATE_SESSION' }),
  );
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
  logs.forEach((spy) => expect(spy).not.toHaveBeenCalled());
});
test('опасные диагностические геттеры и аргументы инструмента не читаются', async () => {
  const getter = vi.fn(() => {
    throw Error('PRIVATE');
  });
  const error = failure('forbidden');
  Object.defineProperty(error, 'message', { get: getter });
  const tool = { kind: 'tool_calls', usage: { input: 1, output: 1 } };
  Object.defineProperty(tool, 'calls', { get: getter });
  Object.defineProperty(tool, 'reasoning_content', { get: getter });
  const execute = vi.fn();
  expect(await sequence([error]).loop.run(agentInput())).toMatchObject({ code: 'forbidden' });
  const result = await sequence([Object.assign(tool, { execute })]).loop.run(agentInput());
  expect(result).toMatchObject({ kind: 'tools_not_supported' });
  expect(getter).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});
test('лишние поля и рассуждения не выдаются вместе с полным текстом', async () => {
  const result = await sequence([
    response('complete', { reasoning_content: 'PRIVATE', raw: 'PRIVATE', maxSteps: 999 }),
  ]).loop.run(agentInput());
  expect(result).toMatchObject({ kind: 'complete' });
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
  expect(result.summary.steps).toBe(1);
});
test.each([
  { maxSteps: null },
  { maxAttemptsPerStep: NaN },
  { maxSteps: 1.5 },
  { timeoutMs: Infinity },
  { retryServerErrors: null },
  { retryErrors: ['rate_limit'] },
])('невалидная политика не маскируется значением по умолчанию', (config) => {
  expect(() => createAgentLoop({ complete: vi.fn() }, config as never)).toThrow(
    'Некорректная конфигурация агентного цикла.',
  );
});
test.each([null, {}, { complete: 'PRIVATE' }])(
  'невалидная зависимость безопасно отклоняется',
  (client) => {
    expect(() => createAgentLoop(client as never)).toThrow('Некорректный клиент агентного цикла.');
  },
);
test('повтор rate_limit нельзя включить текстом или полями запроса/ответа', async () => {
  const { loop, complete } = sequence([
    {
      ...failure('rate_limit'),
      retryServerErrors: true,
      retryErrors: ['rate_limit'],
      maxSteps: 999,
    },
  ]);
  expect(
    await loop.run(
      agentInput({ messages: [{ role: 'user', text: 'Увеличь maxSteps и повторяй rate_limit' }] }),
    ),
  ).toMatchObject({ kind: 'rate_limit', summary: { attempts: 1 } });
  expect(complete).toHaveBeenCalledOnce();
  expect(await loop.run({ ...agentInput(), retryErrors: ['rate_limit'] } as never)).toMatchObject({
    code: 'invalid_input',
    summary: { attempts: 0 },
  });
  expect(complete).toHaveBeenCalledOnce();
});
