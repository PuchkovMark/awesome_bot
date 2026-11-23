import { expect, test, vi } from 'vitest';
import { createLlmClient } from '../src/llm/index';
import type { LlmRequest } from '../src/llm/index';
import { completion, llmConfig, llmRequest } from './helpers/llm-http';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { resolve, promise };
}
test('обратный порядок ответов не смешивает параллельные сессии', async () => {
  const a = deferred<Response>(),
    b = deferred<Response>();
  const fetch = vi.fn((_url: string, init: RequestInit) => {
    void _url;
    return (init.headers as Record<string, string>)['x-opencode-session'] === 'a'
      ? a.promise
      : b.promise;
  });
  const client = createLlmClient(llmConfig, { fetch });
  const first = client.complete(
    llmRequest({ sessionId: 'a', messages: [{ role: 'user', text: 'A' }] }),
  );
  const second = client.complete(
    llmRequest({ sessionId: 'b', messages: [{ role: 'user', text: 'B' }] }),
  );
  b.resolve(Response.json(completion('Ответ B')));
  expect(await second).toMatchObject({ text: 'Ответ B' });
  a.resolve(Response.json(completion('Ответ A')));
  expect(await first).toMatchObject({ text: 'Ответ A' });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fetch.mock.calls[0]![1].body as string).messages[1].content).toBe('A');
  expect(JSON.parse(fetch.mock.calls[1]![1].body as string).messages[1].content).toBe('B');
});
test('снимок конфигурации, вложенных схем, сообщений и списков вызовов', async () => {
  const config = { ...llmConfig } as { provider: 'opencode'; apiKey: string; model: string };
  const pending = deferred<Response>();
  const fetch = vi.fn((_url: string, _init: RequestInit) => {
    void _url;
    void _init;
    return pending.promise;
  });
  const client = createLlmClient(config, { fetch });
  config.model = 'mutated-model';
  config.apiKey = 'mutated-key';
  const request = {
    system: 'Original',
    messages: [
      {
        role: 'assistant' as const,
        text: 'A',
        toolCalls: [{ id: '1', name: 'lookup', arguments: '{original' }],
      },
    ],
    tools: [
      {
        name: 'lookup',
        description: 'Original',
        parameters: { type: 'object' as const, properties: { q: { type: 'string' } } },
      },
    ],
    sessionId: 'original-session',
    maxOutputTokens: 1,
  } satisfies LlmRequest;
  const result = client.complete(request);
  request.system = 'Changed';
  request.messages[0]!.text = 'Changed';
  request.messages[0]!.toolCalls[0]!.arguments = '{changed';
  request.messages[0]!.toolCalls.push({ id: '2', name: 'extra', arguments: '' });
  request.tools[0]!.description = 'Changed';
  request.tools[0]!.parameters.properties.q.type = 'number';
  request.sessionId = 'changed-session';
  request.maxOutputTokens = 100;
  pending.resolve(Response.json(completion('Done')));
  await result;
  const init = fetch.mock.calls[0]![1];
  const body = JSON.parse(init.body as string);
  expect(body.model).toBe(llmConfig.model);
  expect(body.max_tokens).toBe(1);
  expect(init.headers).toMatchObject({
    Authorization: 'Bearer synthetic-key',
    'x-opencode-session': 'original-session',
  });
  expect(body.messages).toEqual([
    { role: 'system', content: 'Original' },
    {
      role: 'assistant',
      content: 'A',
      tool_calls: [
        { id: '1', type: 'function', function: { name: 'lookup', arguments: '{original' } },
      ],
    },
  ]);
  expect(body.tools[0].function.description).toBe('Original');
  expect(body.tools[0].function.parameters.properties.q.type).toBe('string');
});
test('отмена одной сессии не отменяет другую и не меняет завершённый результат', async () => {
  const pending = deferred<Response>();
  const controller = new AbortController();
  const fetch = vi.fn((_url: string, init: RequestInit) => {
    void _url;
    return (init.headers as Record<string, string>)['x-opencode-session'] === 'a'
      ? new Promise<Response>(() => {})
      : pending.promise;
  });
  const client = createLlmClient(llmConfig, { fetch });
  const a = client.complete(llmRequest({ sessionId: 'a', signal: controller.signal }));
  const b = client.complete(llmRequest({ sessionId: 'b' }));
  controller.abort();
  expect(await a).toMatchObject({ code: 'cancelled' });
  pending.resolve(Response.json(completion('B')));
  const result = await b;
  expect(result).toMatchObject({ text: 'B' });
  expect(Object.isFrozen(result)).toBe(true);
  expect(fetch.mock.calls[1]![1].signal?.aborted).toBe(false);
});
