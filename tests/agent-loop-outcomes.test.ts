import { expect, test, vi } from 'vitest';
import { createAgentLoop } from '../src/core/index';
import { agentInput, failure, response, sequence } from './helpers/agent-loop';

test('полный текст сохраняется буквально, шаг и попытка учтены', async () => {
  const { loop, complete } = sequence([response()]);
  expect(complete).not.toHaveBeenCalled();
  const result = await loop.run(agentInput());
  expect(result).toMatchObject({
    kind: 'complete',
    text: ' Ответ\n',
    summary: {
      steps: 1,
      attempts: 1,
      attemptsPerStep: [1],
      usage: { input: { knownTokens: 10, unknownAttempts: 0 } },
    },
  });
  expect(complete.mock.calls[0]![0]).toMatchObject({
    system: 'Системные инструкции',
    messages: [{ role: 'user', text: 'Привет\n' }],
    maxOutputTokens: 128,
    sessionId: 'synthetic',
  });
  expect(complete.mock.calls[0]![0]).not.toHaveProperty('tools');
});
test.each(['incomplete', 'refused', 'empty', 'tool_calls'])(
  '%s не превращается в complete и не продолжается',
  async (kind) => {
    const { loop, complete } = sequence([response(kind)]);
    const result = await loop.run(agentInput());
    expect(result.kind).toBe(kind === 'tool_calls' ? 'tools_not_supported' : kind);
    if (result.kind === 'incomplete') expect(result.partialText).toBe(' Ответ\n');
    else expect(result).not.toHaveProperty('text');
    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.summary.steps).toBe(1);
  },
);
test.each([
  'rate_limit',
  'cancelled',
  'network',
  'timeout',
  'authentication',
  'forbidden',
  'invalid_request',
  'invalid_response',
  'unsupported_response',
  'response_too_large',
  'http',
])('безопасный исход %s не повторяется', async (code) => {
  const { loop, complete } = sequence([failure(code)]);
  const result = await loop.run(agentInput());
  expect(result).toMatchObject(
    code === 'rate_limit' || code === 'cancelled' ? { kind: code } : { kind: 'error', code },
  );
  expect(JSON.stringify(result)).not.toContain('UNTRUSTED');
  expect(complete).toHaveBeenCalledOnce();
});
test.each([
  null,
  {},
  { kind: 'unexpected' },
  response('complete', { text: ' \n' }),
  response('complete', { text: 7 }),
  failure('invented'),
])('неверная форма ответа даёт client_failure', async (value) => {
  const { loop } = sequence([value]);
  expect(await loop.run(agentInput())).toMatchObject({ kind: 'error', code: 'client_failure' });
});
test.each([true, false])(
  'синхронный/асинхронный сбой клиента не выходит наружу: %s',
  async (synchronous) => {
    const complete = vi.fn(() => {
      if (synchronous) throw Error('PRIVATE');
      return Promise.reject(Error('PRIVATE'));
    });
    const loop = createAgentLoop({ complete });
    expect(await loop.run(agentInput())).toMatchObject({
      kind: 'error',
      code: 'client_failure',
      summary: { steps: 1, attempts: 1 },
    });
    expect(complete).toHaveBeenCalledOnce();
  },
);
test.each([
  { tools: [] },
  { maxSteps: 99 },
  { messages: [{ role: 'tool', text: 'private', callId: 'x' }] },
  { messages: [{ role: 'assistant', text: 'a', toolCalls: [] }] },
  { messages: [] },
  { messages: new Array(1) },
  { maxOutputTokens: 0 },
  { sessionId: 'vk:raw' },
  { signal: Object.create(AbortSignal.prototype) },
])('неверный/инструментальный ввод отклоняется до вызова', async (patch) => {
  const { loop, complete } = sequence([]);
  const result = await loop.run(agentInput(patch as never));
  expect(result).toMatchObject({
    code: 'invalid_input',
    summary: { steps: 0, attempts: 0, attemptsPerStep: [] },
  });
  expect(complete).not.toHaveBeenCalled();
});
