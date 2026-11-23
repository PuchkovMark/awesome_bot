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

test('запрашивает полный состав, проверяет страницы и считает уникальных людей', async () => {
  const api = vi
    .fn()
    .mockResolvedValueOnce(page([1, 1, -99], 4))
    .mockResolvedValueOnce(page([2], 4));
  // После дублирующейся строки фактический состав неполон.
  expect(await readVkHumanMembership(api, peer, guard)).toEqual({ complete: false });
  expect(api.mock.calls.map(([method, params]) => [method, params])).toEqual([
    ['messages.getConversationMembers', { peer_id: peer, offset: 0, count: 1000 }],
    ['messages.getConversationMembers', { peer_id: peer, offset: 3, count: 1000 }],
  ]);
  api
    .mockReset()
    .mockResolvedValueOnce(page([1, -99], 4))
    .mockResolvedValueOnce(page([2, 3], 4));
  expect(await readVkHumanMembership(api, peer, guard)).toEqual({ complete: true, people: 3 });
  api
    .mockReset()
    .mockResolvedValueOnce(page([1], 3))
    .mockResolvedValueOnce(page([], 3));
  expect(await readVkHumanMembership(api, peer, guard)).toEqual({ complete: false });
  api.mockReset().mockRejectedValueOnce(Error('PRIVATE'));
  expect(await readVkHumanMembership(api, peer, guard)).toEqual({ complete: false });
  api.mockReset().mockResolvedValueOnce(page([1, 1, -99], 2));
  expect(await readVkHumanMembership(api, peer, guard)).toEqual({ complete: true, people: 1 });
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
    expect(snapshot()).toMatchObject({ total: { limit: 15000 }, initiative: { limit: 10000 } });
    read.mockResolvedValueOnce({ complete: true, people: 50 });
    await observe();
    expect(
      store.reserve(scope, true, { key: 'one', input: 1000, output: 100, purpose: 'direct' }, now),
    ).toBe(true);
    store.reconcile(scope, 'one', { input: 180000, output: 0 });
    expect(snapshot().total).toMatchObject({ limit: 750000, remaining: 570000 });
    read.mockResolvedValueOnce({ complete: true, people: 51 });
    await observe();
    expect(snapshot().total).toMatchObject({ limit: 765000, remaining: 585000 });
    read.mockResolvedValueOnce({ complete: true, people: 51 });
    await observe();
    expect(snapshot().total.remaining).toBe(585000);
    read.mockResolvedValueOnce({ complete: false });
    await observe();
    expect(snapshot().total.remaining).toBe(585000);

    const late = Promise.withResolvers<HumanMembership>();
    read.mockReturnValueOnce(late.promise).mockResolvedValueOnce({ complete: true, people: 10 });
    const pending = observe();
    expect(await observe()).toBe(true);
    late.resolve({ complete: true, people: 55 });
    expect(await pending).toBe(false);
    expect(snapshot().total).toMatchObject({ limit: 150000, remaining: 0 });

    store.update(scope, true, { total: 700000, initiative: 9000 }, now);
    read.mockResolvedValueOnce({ complete: true, people: 70 });
    await observe();
    expect(snapshot()).toMatchObject({
      total: { limit: 700000, remaining: 520000 },
      initiative: { limit: 9000 },
    });
    store.update(scope, true, { total: null }, now);
    expect(snapshot().total.limit).toBe(1050000);

    const replacement = Promise.withResolvers<HumanMembership>();
    read.mockReturnValueOnce(replacement.promise);
    const stale = observe();
    const lifecycle = lifecycleBackend(storage);
    const next = lifecycle.ownerDecision(lifecycle.begin(scope.chatId), 'new');
    replacement.resolve({ complete: true, people: 95 });
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
