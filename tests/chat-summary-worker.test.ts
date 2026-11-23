import { recapPeriod } from '../src/core/chat-summaries/recap';
import { expect, test } from 'vitest';
import { openStorage } from '../src/storage/index';
import { scopeFor } from './helpers/connection-scope';
import { lifecycleBackend } from '../src/storage/lifecycle-store';
import { chatSummaryStore } from '../src/storage/chat-summary-store';
import { summaryEngine } from '../src/core/chat-summaries/worker';
import { localDay } from '../src/core/chat-summaries/calendar';
test.each([
  [Date.UTC(2026, 2, 29, 12), 23],
  [Date.UTC(2026, 9, 25, 12), 25],
])('местные полуночи учитывают смену смещения', (at, hours) => {
  const day = localDay(at, 'Europe/Berlin');
  expect(day.to - day.from).toBe(hours! * 3_600_000);
});
test('порог 249 и 250, две полные части из 620, остаток, позднее дополнение и сдвиг недели', async () => {
  const db = await openStorage(':memory:');
  try {
    const scope = scopeFor(db, 'vk:42'),
      store = chatSummaryStore(db),
      engine = summaryEngine(store, 250);
    const begin = Date.UTC(2026, 10, 18),
      zone = 'Europe/Moscow',
      today = localDay(begin, zone);
    let count = 0,
      calls = 0;
    function append(n: number) {
      lifecycleBackend(db).transaction(scope, (db) => {
        const insert = db.prepare(
          "INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp) VALUES(?,?,'vk:1','Ира','user','Зал Б',?)",
        );
        for (let i = 0; i < n; i++) insert.run(scope.chatId, String(++count), begin + count);
      });
    }
    const run = () => ({
      scope,
      cutoff: count,
      current: () => true,
      compression: {
        signal: new AbortController().signal,
        inputLimit: 3500,
        outputLimit: 512,
        sessionId: 'synthetic',
        async invoke() {
          calls++;
          return { kind: 'complete' as const, text: 'Зал Б', usage: { input: 1, output: 1 } };
        },
      },
    });
    append(249);
    await engine.maintain(run(), begin, begin + 1000, zone);
    expect(calls).toBe(0);
    append(1);
    await engine.maintain(run(), begin, begin + 2000, zone);
    expect(store.entries(scope, today, 'fragment', count)).toHaveLength(1);
    append(370);
    await engine.maintain(run(), begin, begin + 3000, zone);
    expect(store.entries(scope, today, 'fragment', count)).toHaveLength(2);
    await engine.maintain(run(), begin, today.to, zone);
    expect(store.entries(scope, today, 'day', count)[0]?.count).toBe(620);
    const previous = count;
    append(1);
    await engine.maintain(run(), begin, today.to, zone);
    expect(store.entries(scope, today, 'day', count)[0]?.count).toBe(621);
    expect(store.entries(scope, today, 'day', previous)[0]?.count).toBe(620);
    const nextDay = localDay(today.to, zone, 1);
    await engine.maintain(run(), begin, nextDay.from, zone);
    expect(
      store.entries(
        scope,
        { from: localDay(nextDay.from, zone, -7).from, to: nextDay.from, timezone: zone },
        'rolling',
        count,
      )[0]?.count,
    ).toBe(621);
  } finally {
    await db.close();
  }
});

test('период пересказа учитывает местные часы, исправно обрабатывает неоднозначность и условные вопросы', () => {
  const now = Date.UTC(2026, 10, 23, 12),
    zone = 'Europe/Moscow';
  expect(recapPeriod('Что было вчера с 10:00 до 11:00?', now, zone)).toEqual({
    from: Date.UTC(2026, 10, 22, 7),
    to: Date.UTC(2026, 10, 22, 8),
    timezone: zone,
  });
  expect(recapPeriod('Дай сводку с 2026-11-22T10:00 по 2026-11-22T11:00', now, zone)).toEqual({
    from: Date.UTC(2026, 10, 22, 7),
    to: Date.UTC(2026, 10, 22, 8),
    timezone: zone,
  });
  expect(recapPeriod('Что было вчера вечером?', now, zone)).toBe('clarify');
  expect(recapPeriod('Что было бы, если бы мы закрыли чат?', now, zone)).toBeNull();
  expect(recapPeriod('Перескажи книгу', now, zone)).toBeNull();
});
