import { describe, expect, it, vi } from 'vitest';
import { createVkApi, createVkApiCall } from '../src/channels/vk/api.js';
import { createVkRateLimiter, VkRequestCancelled } from '../src/channels/vk/rate-limit.js';

function clockFixture() {
  let now = 0;
  const wait = vi.fn(async (ms: number) => { now += ms; });
  return { now: () => now, wait };
}

describe('общий лимитер VK API', () => {
  it('считает чтение, отправку и typing в одном потоке запросов', async () => {
    const clock = clockFixture();
    const starts: number[] = [];
    const attempt = vi.fn(async () => { starts.push(clock.now()); return { response: 1 }; });
    const request = createVkApiCall(attempt, createVkRateLimiter(clock));
    const operations = ['users.get', 'messages.send', 'messages.setActivity'] as const;
    await Promise.all(Array.from({ length: 23 }, (_, i) => request(operations[i % operations.length]!, {})));
    expect(starts).toEqual(Array.from({ length: 23 }, (_, i) => i * 50));
    expect(attempt).toHaveBeenCalledTimes(23);
  });

  it('ожидает разрешение перед запуском и освобождает очередь после отмены', async () => {
    const clock = clockFixture();
    const limit = createVkRateLimiter(clock);
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<boolean>();
    const sideEffect = vi.fn(async () => 'effect');
    const blocked = limit(sideEffect, {
      signal: controller.signal, allow() { entered.resolve(); return gate.promise; },
    });
    const cancelled = expect(blocked).rejects.toBeInstanceOf(VkRequestCancelled);
    const following = limit(async () => 'next');
    await entered.promise;
    controller.abort();
    await cancelled;
    await expect(following).resolves.toBe('next');
    gate.resolve(true);
    expect(sideEffect).not.toHaveBeenCalled();
  });

  it('проверяет актуальность после асинхронного допуска и не ждёт ответ предыдущего запроса', async () => {
    const clock = clockFixture();
    const limit = createVkRateLimiter(clock);
    const network = Promise.withResolvers<string>();
    const old = limit(() => network.promise);
    const entered = Promise.withResolvers<void>();
    const latestSettings = Promise.withResolvers<boolean>();
    let current = true;
    const sideEffect = vi.fn(async () => 'effect');
    const guarded = limit(sideEffect, {
      isCurrent: () => current,
      allow() { entered.resolve(); return latestSettings.promise; },
    });
    const rejected = expect(guarded).rejects.toBeInstanceOf(VkRequestCancelled);
    await entered.promise;
    current = false;
    latestSettings.resolve(true);
    await rejected;
    expect(sideEffect).not.toHaveBeenCalled();
    network.resolve('first');
    await expect(old).resolves.toBe('first');
  });

  it('сохраняет код VK, скрывает сырой ответ и оставляет повтор вызывающему коду', async () => {
    const attempt = vi.fn(async () => ({ error: { error_code: 6, error_msg: 'secret' } }));
    const request = createVkApiCall(attempt, createVkRateLimiter(clockFixture()));
    await expect(request('messages.send', {})).rejects.toMatchObject({ code: 6, message: 'VK API error 6' });
    expect(attempt).toHaveBeenCalledOnce();
    await expect(request('messages.send', {})).rejects.toMatchObject({ code: 6 });
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('выдаёт неизвестный исход при одновременных ответе и ошибке', async () => {
    const request = createVkApiCall(async () => ({ response: [], error: { error_code: 6 } }), createVkRateLimiter(clockFixture()));
    await expect(request('messages.send', {})).rejects.toMatchObject({ code: undefined, message: 'VK API request failed' });
  });

  it('ограничивает повторы чтения при ошибке VK, считая каждую попытку', async () => {
    const attempt = vi.fn(async () => ({ error: { error_code: 6 } }));
    const request = createVkApiCall(attempt, createVkRateLimiter(clockFixture()));
    const api = createVkApi(314, request);
    await expect(api.getLongPollServer()).rejects.toMatchObject({ code: 6 });
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it('после остановки не повторяет начатый запрос сервера и не начинает чтение профиля', async () => {
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const attempt = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      return { error: { error_code: 6 } };
    });
    const request = createVkApiCall(attempt, createVkRateLimiter(clockFixture()));
    const api = createVkApi(314, request, controller.signal);
    const pending = expect(api.getLongPollServer(controller.signal)).rejects.toMatchObject({ code: 6 });
    await entered.promise;
    controller.abort();
    release.resolve();
    await pending;
    expect(await api.getUserName(73)).toBeNull();
    expect(attempt).toHaveBeenCalledOnce();
  });
});
