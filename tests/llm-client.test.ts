import { expect, test, vi } from 'vitest';
import { createLlmClient } from '../src/llm/index.js';
import type { LlmRequest } from '../src/llm/index.js';
import { completion, fakeClient, llmConfig, llmRequest } from './helpers/llm-http.js';

test('точный Go endpoint, модель, авторизация и буквальные сообщения', async () => {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => { void _url; void _init; return Response.json(completion()); });
  const client = createLlmClient(llmConfig, { fetch });
  expect(fetch).not.toHaveBeenCalled();
  expect(await client.complete(llmRequest())).toEqual({ kind: 'complete', text: ' Ответ\n', usage: { input: null, output: null } });
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = fetch.mock.calls[0]!;
  expect(url).toBe('https://opencode.ai/inference/go/openai/v1/chat/completions');
  expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: {
    Authorization: 'Bearer synthetic-key', 'User-Agent': 'awesome_bot/0.0.0', 'x-opencode-session': 'synthetic-session', 'Content-Type': 'application/json',
  } });
  expect(init.signal).toBeInstanceOf(AbortSignal);
  expect(JSON.parse(init.body as string)).toEqual({ model: llmConfig.model, max_tokens: 128, messages: [
    { role: 'system', content: 'Инструкции' }, { role: 'user', content: ' Привет\n' },
  ] });
});
test.each([null, {}, { model: '' }, { ...llmConfig, apiKey: 'secret\nheader' }, { ...llmConfig, provider: 'other' }])('неверная конфигурация безопасно отклоняется', (config) => {
  expect(() => createLlmClient(config as typeof llmConfig)).toThrow('Некорректная конфигурация клиента LLM.');
});
test.each([0, -1, NaN, Infinity, 1.1, 2_147_483_648])('неверный timeout %s отклоняется', (timeoutMs) => {
  expect(() => createLlmClient(llmConfig, { timeoutMs })).toThrow('Некорректная конфигурация клиента LLM.');
});
test.each([
  { messages: [] }, { maxOutputTokens: 0 }, { maxOutputTokens: NaN }, { system: null },
  { sessionId: 'vk:raw-chat' }, { sessionId: 'x\r\nheader' }, { signal: {} },
  { messages: [{ role: 'system', text: 'inject' }] }, { messages: [{ role: 'assistant' }] },
  { tools: [{ name: 'x', description: '', parameters: { type: 'array' } }] },
])('неверный запрос отклоняется до сети: %j', async (patch) => {
  const { client, fetch } = fakeClient();
  expect(await client.complete(llmRequest(patch as Partial<LlmRequest>))).toMatchObject({ kind: 'error', code: 'invalid_request' });
  expect(fetch).not.toHaveBeenCalled();
});
test('циклы и непредставимые схемы не теряются молча', async () => {
  const cyclic: Record<string, unknown> = { type: 'object' }; cyclic.self = cyclic;
  for (const parameters of [cyclic, { type: 'object', value: undefined }, { type: 'object', value: NaN }, { type: 'object', value: 1n }]) {
    const { client, fetch } = fakeClient();
    const request = llmRequest({ tools: [{ name: 'x', description: '', parameters: parameters as never }] });
    expect(await client.complete(request)).toMatchObject({ code: 'invalid_request' });
    expect(fetch).not.toHaveBeenCalled();
  }
});
