import { afterEach, expect, test, vi } from 'vitest';
import { createLlmClient } from '../src/llm/index';
import { fakeClient, llmConfig, llmRequest } from './helpers/llm-http';

afterEach(() => {
  vi.restoreAllMocks();
});
test.each([
  [401, 'authentication'],
  [403, 'forbidden'],
  [429, 'rate_limit'],
  [500, 'server'],
  [503, 'server'],
  [302, 'http'],
  [400, 'http'],
  [204, 'http'],
])('HTTP %s: безопасная категория и одна попытка', async (status, code) => {
  const cancel = vi.fn();
  const body = new ReadableStream({ cancel });
  const fetch = vi.fn(
    async () =>
      new Response(status === 204 ? null : body, {
        status: status as number,
        statusText: 'SENSITIVE_BODY',
        headers: { 'x-private': 'SENSITIVE_HEADER' },
      }),
  );
  const client = createLlmClient(llmConfig, { fetch });
  const result = await client.complete(llmRequest());
  expect(result).toMatchObject({ kind: 'error', code });
  expect(JSON.stringify(result)).not.toMatch(/SENSITIVE|synthetic-key|Привет/);
  expect(fetch).toHaveBeenCalledTimes(1);
  if (status !== 204) expect(cancel).toHaveBeenCalledOnce();
});

test.each([
  ['17', 17_000],
  ['0', 0],
  ['Tue, 24 Nov 2026 12:00:25 GMT', 25_000],
  ['Tuesday, 24-Nov-26 12:00:25 GMT', 25_000],
  ['Tue Nov 24 12:00:25 2026', 25_000],
  ['Tue, 24 Nov 2026 11:59:59 GMT', 0],
  [null, undefined],
  ['-1', undefined],
  ['1.5', undefined],
  ['8640000000000', undefined],
  ['Tue, 31 Nov 2026 12:00:25 GMT', undefined],
  ['2026-11-24T12:00:25Z', undefined],
  ['SENSITIVE_BAD HEADER', undefined],
] as const)('HTTP 429 с Retry-After %s', async (header, delay) => {
  const now = Date.UTC(2026, 10, 24, 12);
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const cancel = vi.fn();
  const body = new ReadableStream({ cancel });
  const headers = {
    'x-private': 'SENSITIVE_HEADER',
    ...(header === null ? {} : { 'Retry-After': header }),
  };
  const fetch = vi.fn(async () => new Response(body, { status: 429, headers }));
  const result = await createLlmClient(llmConfig, { fetch }).complete(llmRequest());
  expect(result).toEqual({
    kind: 'error',
    code: 'rate_limit',
    message: 'Достигнут лимит провайдера.',
    ...(delay === undefined ? {} : { retryAt: now + delay }),
  });
  expect(fetch).toHaveBeenCalledOnce();
  expect(cancel).toHaveBeenCalledOnce();
});
test.each([
  new Error('SENSITIVE', { cause: 'SENSITIVE_CAUSE' }),
  'SENSITIVE',
  null,
  { raw: 'SENSITIVE' },
])('ошибка транспорта не выходит наружу', async (failure) => {
  const fetch = vi.fn(async () => {
    throw failure;
  });
  const client = createLlmClient(llmConfig, { fetch });
  const result = await client.complete(llmRequest());
  expect(result).toEqual({
    kind: 'error',
    code: 'network',
    message: 'Ошибка соединения с провайдером.',
  });
  expect(fetch).toHaveBeenCalledOnce();
});
test.each(['{broken SENSITIVE', new Uint8Array([0xff, 0xfe])])(
  'неверный JSON или UTF-8 не раскрывает тело',
  async (body) => {
    const { client } = fakeClient(undefined, { fetch: async () => new Response(body) });
    expect(await client.complete(llmRequest())).toMatchObject({ code: 'invalid_response' });
  },
);
test('разрыв чтения тела — безопасная сетевая ошибка без повторов', async () => {
  const fetch = vi.fn(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(Error('SENSITIVE'));
          },
        }),
      ),
  );
  const result = await createLlmClient(llmConfig, { fetch }).complete(llmRequest());
  expect(result).toMatchObject({ code: 'network' });
  expect(JSON.stringify(result)).not.toContain('SENSITIVE');
  expect(fetch).toHaveBeenCalledOnce();
});
test('диагностика клиента не печатает ни запрос, ни ошибки, включая debug', async () => {
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const spies = methods.map((key) => vi.spyOn(console, key).mockImplementation(() => {}));
  const fetch = vi.fn(async () => {
    throw Error('SENSITIVE_MESSAGE', { cause: { headers: { authorization: 'SENSITIVE_KEY' } } });
  });
  const client = createLlmClient({ ...llmConfig, apiKey: 'SENSITIVE_KEY' }, { fetch });
  const result = await client.complete(llmRequest({ system: 'SENSITIVE_PROMPT' }));
  expect(JSON.stringify(result)).not.toContain('SENSITIVE');
  spies.forEach((spy) => expect(spy).not.toHaveBeenCalled());
});
