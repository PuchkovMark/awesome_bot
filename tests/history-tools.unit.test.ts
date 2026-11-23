import { expect, test, vi } from 'vitest';
import { historyTools } from '../src/tools/history';
import type { ContextRecord } from '../src/storage/context-types';
import type { HistorySelection } from '../src/storage/context-reader';
import { createToolRegistry } from '../src/tools/registry';
import { messageInputCost } from '../src/core/context/budget';
import { createContextAuthority } from '../src/core/authorization/context';
import type { ConnectionScope } from '../src/contracts/index';
import { FakeAdapter } from './helpers/fake-adapters';

const scope = { chatId: 'test-a:room', generation: 1 } as unknown as ConnectionScope;
const callId = 'вызов';
const cost = (text: string) =>
  messageInputCost(Buffer.byteLength(JSON.stringify({ role: 'tool', callId, text })));
function fixture(texts: string[], found = texts.length) {
  const userId = 'test-a:actor';
  const rows: ContextRecord[] = texts.map((text, i) => ({
    chatId: scope.chatId,
    id: texts.length - i,
    messageId: String(i),
    userId,
    role: 'user',
    authorName: 'Я',
    timestamp: 100,
    purpose: 'conversation',
    text,
    truncated: false,
  }));
  const read = vi.fn((_scope: ConnectionScope, q: HistorySelection) => ({
    found,
    rows: rows.slice(0, q.limit),
    countsCurrent: () => true,
  }));
  const principal = createContextAuthority(userId).create({ scope, userId });
  const registry = createToolRegistry(
    historyTools({
      principal,
      group: true,
      timezone: 'UTC',
      cutoffId: 99,
      author: (ref) => (ref === 'current' ? { author: userId } : undefined),
      read,
    }),
    {
      chatId: scope.chatId,
      platform: 'test-a',
      userId,
      isAdmin: false,
      adapter: new FakeAdapter('test-a'),
      authorization: principal,
    },
    () => true,
  );
  return {
    read,
    async call(
      args: Record<string, unknown> = {},
      name = 'history_search',
      fits?: (text: string) => boolean,
    ) {
      return registry.execute(
        { name, id: callId, arguments: JSON.stringify(args) },
        await registry.schemas(),
        false,
        fits,
      );
    },
  };
}

test('полный сериализованный ответ ограничен ровно 2048 единицами', async () => {
  const baseline = await fixture(['a']).call();
  const length = 1 + 2048 - cost(baseline.text);
  const exact = await fixture(['a'.repeat(length)]).call();
  expect(cost(exact.text)).toBe(2048);
  expect(JSON.parse(exact.text).messages[0].truncated).toBeUndefined();
  const over = await fixture(['a'.repeat(length + 1)]).call();
  expect(JSON.parse(over.text).messages[0].truncated).toBe(true);
  expect(cost(over.text)).toBeLessThanOrEqual(2048);
  const small = await fixture(['Маяк "🌊"'.repeat(250)]).call(
    {},
    'history_search',
    (text) => cost(text) <= 760,
  );
  expect(cost(small.text)).toBeLessThanOrEqual(760);
  expect(JSON.parse(small.text)).toMatchObject({
    found: 1,
    shown: 1,
    messages: [{ truncated: true }],
  });
  expect(small.sourceIds).toEqual([1]);
});
test('метаданные сохраняют полный счётчик, действуют лимит и сортировка', async () => {
  const f = fixture(['последнее', 'первое'], 7);
  for (const limit of [undefined, 1, 10000]) {
    const result = await f.call({ limit });
    expect(f.read.mock.lastCall?.[1].limit).toBe(limit === 1 ? 1 : 40);
    expect(JSON.parse(result.text).messages[0].text).toBe('последнее');
  }
  const dates = { from: '1970-01-01T00:00:00Z', to: '1970-01-02T03:00:00+03:00' };
  const period = await f.call(dates, 'history_period');
  expect(JSON.parse(period.text).messages.map((m: { text: string }) => m.text)).toEqual([
    'первое',
    'последнее',
  ]);
  expect(f.read.mock.lastCall?.[1]).toMatchObject({ from: 0, to: 86400000 });
  const metadata = await f.call({}, 'history_search', (text) => JSON.parse(text).shown === 0);
  expect(JSON.parse(metadata.text)).toMatchObject({ found: 7, shown: 0 });
  expect(metadata.sourceIds).toEqual([]);
  expect((await f.call({}, 'history_search', () => false)).budgetExhausted).toBe(true);
  expect(JSON.parse((await fixture([]).call()).text)).toMatchObject({ found: 0, shown: 0 });
});
test('валидация дат, области и автора происходит до чтения', async () => {
  const f = fixture([]);
  const to = '2026-02-28T23:59:00Z';
  for (const from of ['2026-02-01T00:00:00', '2026-02-30T00:00:00Z', to, '2026-03-01T00:00:00Z']) {
    expect((await f.call({ from, to }, 'history_period')).outcome).toBe('failed');
  }
  expect((await f.call({ to }, 'history_period')).outcome).toBe('denied');
  expect((await f.call({ chatId: 'test-a:other' })).outcome).toBe('denied');
  expect(JSON.parse((await f.call({ author: 'Саша' })).text).clarify).toBeTruthy();
  expect(f.read).not.toHaveBeenCalled();
});
