import { expect, test, vi } from 'vitest';
import { createLlmClient } from '../src/llm/index.js';
import { completion, fakeClient, llmConfig, llmRequest, toolCall } from './helpers/llm-http.js';

test('описания, вызов assistant и результат tool передаются без полномочий и исполнения', async () => {
  const execute = vi.fn();
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => { void _url; void _init; return Response.json(completion()); });
  const client = createLlmClient(llmConfig, { fetch });
  await client.complete(llmRequest({ tools: [{ name: 'lookup', description: 'Поиск', parameters: { type: 'object', properties: { query: { type: 'string' } } }, execute, access: 'write' } as never], messages: [
    { role: 'user', text: 'Найди' },
    { role: 'assistant', toolCalls: [{ id: 'id', name: 'lookup', arguments: '{не JSON' }] },
    { role: 'tool', callId: 'id', text: 'Недоверенный результат\n' },
  ] }));
  const body = JSON.parse(fetch.mock.calls[0]![1].body as string);
  expect(body.tools).toEqual([{ type: 'function', function: { name: 'lookup', description: 'Поиск', parameters: { type: 'object', properties: { query: { type: 'string' } } } } }]);
  expect(body.messages.slice(2)).toEqual([
    { role: 'assistant', content: null, tool_calls: [{ id: 'id', type: 'function', function: { name: 'lookup', arguments: '{не JSON' } }] },
    { role: 'tool', tool_call_id: 'id', content: 'Недоверенный результат\n' },
  ]);
  expect(execute).not.toHaveBeenCalled(); expect(JSON.stringify(body)).not.toMatch(/execute|access|authorization|adapter/);
});
test('несколько запрошенных вызовов сохраняют аргументы буквально, неизвестное имя не исполняется', async () => {
  const { client } = fakeClient(completion('Сопутствующий текст', 'tool_calls', { tool_calls: [toolCall(), toolCall('second', 'not-issued', '[]')] }));
  expect(await client.complete(llmRequest())).toEqual({ kind: 'tool_calls', text: 'Сопутствующий текст', calls: [
    { id: 'call-1', name: 'lookup', arguments: '{не JSON' }, { id: 'second', name: 'not-issued', arguments: '[]' },
  ], usage: { input: null, output: null } });
});
test.each([
  [], [toolCall(), toolCall()], [{ ...toolCall(), id: '' }], [toolCall('x', '')], [toolCall('x', 'a', {} as never)],
  [{ ...toolCall(), type: 'other' }], 'not-array',
])('некорректный конверт вызовов не становится ответом', async (tool_calls) => {
  const { client } = fakeClient(completion(null, 'tool_calls', { tool_calls }));
  expect(await client.complete(llmRequest())).toMatchObject({ code: 'invalid_response' });
});
test.each(['stop', 'length'])('вызовы с завершением %s не становятся полным ответом', async (finish) => {
  const { client } = fakeClient(completion('text', finish, { tool_calls: [toolCall()] }));
  expect(await client.complete(llmRequest())).toMatchObject({ kind: 'error' });
});
