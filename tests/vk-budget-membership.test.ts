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

test('полные снимки входа, выхода и повтора меняют лимит без сброса расхода', async () => {
  const storage = await openStorage(':memory:');
  try {
    const scope = scopeFor(storage, 'vk:2000000001');
    const personal = scopeFor(storage, 'vk:1');
    const other = scopeFor(storage, 'vk:2');
    const store = tokenBudgetStore(storage);
    const now = Date.parse('2026-11-23T12:00:00Z');
    const snapshot = () => store.read(scope, true, now);
    const read = vi.fn<() => Promise<HumanMembership>>();
    const refresh = createTokenBudgetMembership(storage, read);
    const observe = () => refresh(scope, guard.signal, guard.isCurrent);
    expect(snapshot()).toMatchObject({ total: { limit: 500_000 }, initiative: { limit: 10_000 } });
    read.mockResolvedValueOnce(full(50));
    await observe();
    expect(
      store.reserve(scope, true, { key: 'one', input: 1000, output: 100, purpose: 'direct' }, now),
    ).toBe(true);
    store.reconcile(scope, 'one', { input: 180000, output: 0 });
    expect(snapshot().total).toMatchObject({ limit: 1_100_000, remaining: 920_000 });
    read.mockResolvedValueOnce(full(51));
    await observe();
    expect(snapshot().total).toMatchObject({ limit: 1_100_000, remaining: 920_000 });
    read.mockResolvedValueOnce(full(51));
    await observe();
    expect(snapshot().total.remaining).toBe(920_000);
    read.mockResolvedValueOnce({ complete: false });
    await observe();
    expect(snapshot().total.remaining).toBe(920_000);

    const late = Promise.withResolvers<HumanMembership>();
    read.mockReturnValueOnce(late.promise).mockResolvedValueOnce(full(10));
    const pending = observe();
    expect(await observe()).toBe(true);
    late.resolve(full(55));
    expect(await pending).toBe(false);
    expect(snapshot().total).toMatchObject({ limit: 500_000, remaining: 320_000 });

    store.update(scope, true, { total: 700000, initiative: 9000 }, now);
    read.mockResolvedValueOnce(full(70));
    await observe();
    expect(snapshot()).toMatchObject({
      total: { limit: 700000, remaining: 520000 },
      initiative: { limit: 9000 },
    });
    store.update(scope, true, { total: null }, now);
    expect(snapshot().total.limit).toBe(1_400_000);

    const replacement = Promise.withResolvers<HumanMembership>();
    read.mockReturnValueOnce(replacement.promise);
    const stale = observe();
    const lifecycle = lifecycleBackend(storage);
    const next = lifecycle.ownerDecision(lifecycle.begin(scope.chatId), 'new');
    replacement.resolve(full(95));
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
    await storage.close();
  }
});
