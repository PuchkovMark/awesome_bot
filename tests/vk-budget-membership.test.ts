import { expect, test, vi } from 'vitest';
import { readVkHumanMembership } from '../src/channels/vk/api';
import { createTokenBudgetMembership } from '../src/core/chat-limits/token-budget-membership';
import { openStorage } from '../src/storage/index';
import { tokenBudgetStore } from '../src/storage/token-budget-store';
import { lifecycleBackend } from '../src/storage/lifecycle-store';
import type { HumanMembership } from '../src/contracts/index';
import { scopeFor } from './helpers/connection-scope';

const peer = 2000000001;
const guard = { signal: new AbortController().signal, isCurrent: () => true };
const page = (ids: readonly number[], count = ids.length) => ({
  count,
  items: ids.map((member_id) => ({ member_id })),
});

function full(people: number): Extract<HumanMembership, { complete: true }> {
  return {
    complete: true,
    people,
    members: Array.from({ length: people }, (_, i) => ({ userId: `vk:${i + 1}`, role: 'unknown' })),
  };
}

test('единая выборка возвращает людей и платформенные роли из нескольких страниц', async () => {
  const api = vi
    .fn()
    .mockResolvedValueOnce({
      count: 4,
      items: [{ member_id: 1, is_admin: true }, { member_id: -99 }],
    })
    .mockResolvedValueOnce({
      count: 4,
      items: [{ member_id: 2, is_admin: false }, { member_id: 3 }],
    });
  expect(await readVkHumanMembership(api, peer, guard)).toEqual({
    complete: true,
    people: 3,
    members: [
      { userId: 'vk:1', role: 'admin' },
      { userId: 'vk:2', role: 'member' },
      { userId: 'vk:3', role: 'unknown' },
    ],
  });
  expect(api.mock.calls.map(([method, params]) => [method, params])).toEqual([
    ['messages.getConversationMembers', { peer_id: peer, offset: 0, count: 1000 }],
    ['messages.getConversationMembers', { peer_id: peer, offset: 2, count: 1000 }],
  ]);
  api.mockReset().mockResolvedValueOnce(page([]));
  expect(await readVkHumanMembership(api, peer, guard)).toEqual(full(0));
  api.mockReset().mockResolvedValueOnce(page([-99]));
  expect(await readVkHumanMembership(api, peer, guard)).toEqual(full(0));
});

test.each([
  ['повтор ID на разных страницах', page([1, -99], 4), page([1, 2], 4)],
  ['лишняя строка', page([1, 1, -99], 2)],
  ['разрыв между страницами', page([1], 3), page([], 3)],
  ['смена общего количества', page([1], 2), page([2], 3)],
  ['неизвестная строка', { count: 2, items: [{ member_id: 1 }, { member_id: '2' }] }],
])(
  'несогласованная выборка %s остаётся неполной',
  async (_description, first, second?: unknown) => {
    const api = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    expect(await readVkHumanMembership(api, peer, guard)).toEqual({ complete: false });
  },
);

test('потеря доступа и отмена после первой страницы не подтверждают состав', async () => {
  const api = vi
    .fn()
    .mockResolvedValueOnce(page([1], 2))
    .mockRejectedValueOnce(Error('PRIVATE'));
  expect(await readVkHumanMembership(api, peer, guard)).toEqual({ complete: false });
  expect(api).toHaveBeenCalledTimes(2);
  const controller = new AbortController();
  api.mockReset().mockImplementationOnce(async () => {
    controller.abort();
    return page([1], 2);
  });
  expect(await readVkHumanMembership(api, peer, { signal: controller.signal })).toEqual({
    complete: false,
  });
  expect(api).toHaveBeenCalledOnce();
});

test('сверка VK пересекает порог 19 → 20 → 19 с сохранением списаний и резерва', async () => {
  const storage = await openStorage(':memory:');
  const now = Date.parse('2026-11-23T12:00:00Z');
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  try {
    const scope = scopeFor(storage, 'vk:2000000001');
    const personal = scopeFor(storage, 'vk:1');
    const other = scopeFor(storage, 'vk:2');
    const store = tokenBudgetStore(storage);
    const snapshot = () =>
      store
        .overview((id) => id === scope.chatId, now)
        .chats.find(({ chatId }) => chatId === scope.chatId)!;
    const nineteen = [...Array.from({ length: 19 }, (_, i) => i + 1), -99];
    const twenty = [...nineteen, 20];
    const api = vi.fn<Parameters<typeof readVkHumanMembership>[0]>();
    const refresh = createTokenBudgetMembership(storage, (_scope, signal) =>
      readVkHumanMembership(api, peer, { signal }),
    );
    const observe = () => refresh(scope, guard.signal, guard.isCurrent);
    const reserve = (key: string, input: number) =>
      store.reserve(scope, true, { key, input, output: 0, purpose: 'direct' }, now);
    expect(snapshot()).toMatchObject({
      people: null,
      total: { limit: 500_000 },
      initiative: { limit: 10_000 },
    });
    api.mockResolvedValueOnce(page(nineteen));
    expect(await observe()).toBe(true);
    expect(snapshot()).toMatchObject({ people: 19, total: { limit: 500_000 } });
    expect(reserve('paid', 480_000)).toBe(true);
    expect(store.reconcile(scope, 'paid', { input: 480_000, output: 0 })).toBe(true);
    expect(reserve('held', 30_000)).toBe(false);

    api.mockResolvedValueOnce(page(twenty));
    expect(await observe()).toBe(true);
    expect(reserve('held', 30_000)).toBe(true);
    const spending = { confirmed: 480_000n, reserved: 30_000n, incompleteAttempts: 1 };
    const raised = snapshot();
    expect(raised).toMatchObject({
      people: 20,
      total: { limit: 800_000, remaining: 290_000, ...spending },
    });
    expect(reserve('fits', 290_001)).toBe(false);
    expect(reserve('fits', 290_000)).toBe(true);
    await store.meter(scope, 'fits').cancelBeforeSend();
    api.mockResolvedValueOnce(page(twenty));
    expect(await observe()).toBe(true);
    expect(snapshot()).toEqual(raised);
    // Первая страница обещает больше строк, следующая ничего не возвращает.
    api
      .mockResolvedValueOnce(page(nineteen, twenty.length))
      .mockResolvedValueOnce(page([], twenty.length));
    expect(await observe()).toBe(false);
    expect(snapshot()).toEqual(raised);

    const late = Promise.withResolvers<ReturnType<typeof page>>();
    api.mockReturnValueOnce(late.promise).mockResolvedValueOnce(page(nineteen));
    const pending = observe();
    expect(await observe()).toBe(true);
    late.resolve(page(twenty));
    expect(await pending).toBe(false);
    expect(snapshot()).toMatchObject({
      people: 19,
      total: { limit: 500_000, remaining: 0, ...spending },
    });
    expect(reserve('later', 1)).toBe(false);

    store.update(scope, true, { total: 700000, initiative: 9000 }, now);
    api.mockResolvedValueOnce(page(twenty));
    expect(await observe()).toBe(true);
    expect(snapshot()).toMatchObject({
      total: { limit: 700_000, remaining: 190_000, ...spending },
      initiative: { limit: 9000 },
    });
    store.update(scope, true, { total: null }, now);
    expect(snapshot().total.limit).toBe(800_000);

    const replacement = Promise.withResolvers<ReturnType<typeof page>>();
    api.mockReturnValueOnce(replacement.promise);
    const stale = observe();
    const lifecycle = lifecycleBackend(storage);
    const next = lifecycle.ownerDecision(lifecycle.begin(scope.chatId), 'new');
    replacement.resolve(page(twenty));
    await expect(stale).rejects.toThrow('stale_scope');
    expect(store.read(next, true, now).people).toBeNull();

    expect(store.read(personal, false, now)).toMatchObject({
      total: { limit: 500000 },
      initiative: null,
    });
    expect(
      store.reserve(
        personal,
        false,
        { key: 'one', input: 100, output: 100, purpose: 'direct' },
        now,
      ),
    ).toBe(true);
    expect(store.read(other, false, now).total.remaining).toBe(500000);
  } finally {
    clock.mockRestore();
    await storage.close();
  }
});
