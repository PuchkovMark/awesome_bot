import { afterEach, expect, test, vi } from 'vitest';
import { createLlmClient } from '../src/llm/index';
import type { LlmResult } from '../src/llm/index';
import { completion, llmConfig, llmRequest } from './helpers/llm-http';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function trackedSignal() {
  const controller = new AbortController();
  return {
    controller,
    add: vi.spyOn(controller.signal, 'addEventListener'),
    remove: vi.spyOn(controller.signal, 'removeEventListener'),
  };
}
test('предварительная отмена исключает транспорт и таймер', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  controller.abort('SENSITIVE_REASON');
  const fetch = vi.fn(async () => Response.json(completion()));
  const client = createLlmClient(llmConfig, { fetch });
  expect(await client.complete(llmRequest({ signal: controller.signal }))).toMatchObject({
    code: 'cancelled',
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
test.each(['timeout', 'cancelled'])(
  'зависший fetch: %s ограничивает ожидание даже без поддержки abort',
  async (code) => {
    vi.useFakeTimers();
    const { controller, add, remove } = trackedSignal();
    const pending = deferred<Response>();
    const fetch = vi.fn((_url: string, init: RequestInit) => {
      void _url;
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return pending.promise;
    });
    const client = createLlmClient(llmConfig, { fetch, timeoutMs: 50 });
    const result = client.complete(llmRequest({ signal: controller.signal }));
    if (code === 'cancelled') controller.abort('SENSITIVE_REASON');
    else await vi.advanceTimersByTimeAsync(50);
    expect(await result).toMatchObject({ kind: 'error', code });
    expect(fetch.mock.calls[0]![1].signal?.aborted).toBe(true);
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]![1]);
    expect(vi.getTimerCount()).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    // Поздний отказ не превращается в unhandled rejection.
    pending.reject(Error('SENSITIVE_LATE_ERROR'));
    await Promise.resolve();
    await Promise.resolve();
  },
);
test('поздний HTTP-ответ после deadline закрывает тело', async () => {
  vi.useFakeTimers();
  const pending = deferred<Response>();
  const cancel = vi.fn();
  const client = createLlmClient(llmConfig, { fetch: () => pending.promise, timeoutMs: 5 });
  const result = client.complete(llmRequest());
  await vi.advanceTimersByTimeAsync(5);
  expect(await result).toMatchObject({ code: 'timeout' });
  pending.resolve(new Response(new ReadableStream({ cancel })));
  await Promise.resolve();
  await Promise.resolve();
  expect(cancel).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
test.each(['timeout', 'cancelled'])(
  'зависшее тело и частичные данные: %s закрывает reader',
  async (code) => {
    vi.useFakeTimers();
    const { controller, add, remove } = trackedSignal();
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(stream) {
          stream.enqueue(new TextEncoder().encode('{'));
        },
        cancel,
      }),
    );
    const client = createLlmClient(llmConfig, { fetch: async () => response, timeoutMs: 20 });
    const result = client.complete(llmRequest({ signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(0);
    if (code === 'cancelled') controller.abort();
    else await vi.advanceTimersByTimeAsync(20);
    expect(await result).toMatchObject({ code });
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]![1]);
    expect(vi.getTimerCount()).toBe(0);
  },
);
test('медленные части тела учитываются общим deadline', async () => {
  vi.useFakeTimers();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const client = createLlmClient(llmConfig, {
    timeoutMs: 20,
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            stream = controller;
          },
        }),
      ),
  });
  const result = client.complete(llmRequest());
  await vi.advanceTimersByTimeAsync(15);
  stream.enqueue(new TextEncoder().encode('{'));
  await vi.advanceTimersByTimeAsync(5);
  expect(await result).toMatchObject({ code: 'timeout' });
  expect(vi.getTimerCount()).toBe(0);
});
test('лимит тела в байтах, точная граница и ложный Content-Length', async () => {
  const text = JSON.stringify(completion('Кириллица'));
  const bytes = new TextEncoder().encode(text);
  for (const limit of [bytes.length, bytes.length - 1]) {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(stream) {
          stream.enqueue(bytes);
          stream.close();
        },
        cancel,
      }),
      { headers: { 'Content-Length': '1' } },
    );
    const result = await createLlmClient(llmConfig, {
      maxResponseBytes: limit,
      fetch: async () => response,
    }).complete(llmRequest());
    expect(result).toMatchObject(
      limit === bytes.length ? { kind: 'complete' } : { code: 'response_too_large' },
    );
    expect(response.body?.locked).toBe(false);
  }
});
test('слишком большое незавершённое тело отменяется без ожидания конца', async () => {
  const cancel = vi.fn();
  const response = new Response(
    new ReadableStream({
      start(stream) {
        stream.enqueue(new Uint8Array(10));
      },
      cancel,
    }),
  );
  const result = await createLlmClient(llmConfig, {
    maxResponseBytes: 9,
    fetch: async () => response,
  }).complete(llmRequest());
  expect(result).toMatchObject({ code: 'response_too_large' });
  expect(cancel).toHaveBeenCalledOnce();
});
test.each(['success', 'invalid_response', 'network', 'http'])(
  'после %s нет таймеров и слушателей',
  async (outcome) => {
    vi.useFakeTimers();
    const { controller, add, remove } = trackedSignal();
    const client = createLlmClient(llmConfig, {
      fetch: async () => {
        if (outcome === 'network') throw Error('SENSITIVE');
        return outcome === 'success'
          ? Response.json(completion())
          : new Response('{', { status: outcome === 'http' ? 400 : 200 });
      },
    });
    const result: LlmResult = await client.complete(llmRequest({ signal: controller.signal }));
    expect(result.kind).toBe(outcome === 'success' ? 'complete' : 'error');
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]![1]);
    expect(vi.getTimerCount()).toBe(0);
  },
);
test('гонка успеха и отмены даёт ровно один результат', async () => {
  vi.useFakeTimers();
  const pending = deferred<Response>();
  const controller = new AbortController();
  const client = createLlmClient(llmConfig, { fetch: () => pending.promise });
  const observer = vi.fn();
  const result = client.complete(llmRequest({ signal: controller.signal })).then(observer);
  pending.resolve(Response.json(completion()));
  controller.abort('PRIVATE');
  await result;
  expect(observer).toHaveBeenCalledTimes(1);
  expect(observer.mock.calls[0]![0]).toMatchObject({ code: 'cancelled' });
  expect(vi.getTimerCount()).toBe(0);
});
