import { vi } from 'vitest';
import { applyHistoryRetention } from '../src/storage/history-retention-store';
import { expect, test } from 'vitest';
import { openStorage } from '../src/storage/index';
import { chatSummaryStore } from '../src/storage/chat-summary-store';
import { lifecycleBackend } from '../src/storage/lifecycle-store';
import { scopeFor } from './helpers/connection-scope';
import { storageFixture } from './helpers/storage-fixture';

test('поколение, возобновление захвата и отзыв вложенных сводок по источнику', async () => {
  const files = storageFixture();
  let storage = await openStorage(files.path);
  const period = { from: 0, to: 100, timezone: 'UTC' };
  try {
    let scope = scopeFor(storage, 'vk:10');
    const message = await storage.messages.append(scope, {
      chatId: scope.chatId,
      role: 'user',
      userId: 'vk:5',
      messageId: '1',
      authorName: 'Ира',
      text: 'Ключ принесу',
      timestamp: 10,
      isGroupChat: true,
    });
    const ids = [message.id];
    let store = chatSummaryStore(storage);
    const first = store.claim(scope, period, 'fragment', ids, [], 0);
    expect(first?.kind).toBe('owned');
    expect(store.claim(scope, period, 'fragment', ids, [], 1)).toBeNull();
    await storage.close();
    storage = await openStorage(files.path);
    store = chatSummaryStore(storage);
    scope = scopeFor(storage, 'vk:10');
    const second = store.claim(scope, period, 'fragment', ids, [], 120001);
    if (first?.kind !== 'owned' || second?.kind !== 'owned')
      throw Error('Ожидался повторный захват');
    expect(store.finish(scope, first.id, first.token, 'устаревшее')).toBeNull();
    const fragment = store.finish(scope, second.id, second.token, 'Ключ у Иры')!;
    const daily = store.claim(scope, period, 'day', ids, [fragment.id], 120002);
    if (daily?.kind !== 'owned') throw Error('Ожидалась работа');
    store.finish(scope, daily.id, daily.token, 'Ключ у Иры');
    expect(store.entries(scope, period, 'day', message.id)).toHaveLength(1);
    expect(store.entries(scopeFor(storage, 'vk:11'), period, 'day', message.id)).toHaveLength(0);
    lifecycleBackend(storage).transaction(scope, (db) =>
      db.prepare('DELETE FROM messages WHERE id=?').run(message.id),
    );
    expect(store.current(scope, [fragment.id, daily.id])).toBe(false);
    expect(store.ids(scope, period, message.id)).toEqual([]);
  } finally {
    await storage.close();
    files.cleanup();
  }
});

test.each(['срок', 'очистка'])(
  'сводка перестаёт читаться на границе истории до физического удаления: %s',
  async (kind) => {
    const storage = await openStorage(':memory:');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      const scope = scopeFor(storage, 'vk:42'),
        store = chatSummaryStore(storage);
      const { id } = await storage.messages.append(scope, {
        chatId: scope.chatId,
        messageId: '1',
        userId: 'vk:1',
        authorName: 'Лев',
        text: 'Встреча',
        role: 'user',
        timestamp: 1000,
      });
      const period = { from: 900, to: 1100, timezone: 'UTC' };
      const claim = store.claim(scope, period, 'day', [id], [], 1000);
      if (claim?.kind !== 'owned') throw Error('Нет диапазона');
      store.finish(scope, claim.id, claim.token, 'Встреча');
      lifecycleBackend(storage).transaction(scope, (db) => applyHistoryRetention(db, 100, 1000));
      clock.mockReturnValue(1099);
      expect(store.entries(scope, period, 'day', id)).toHaveLength(1);
      if (kind === 'срок') clock.mockReturnValue(1100);
      else
        lifecycleBackend(storage).transaction(scope, (db) =>
          db
            .prepare(
              'INSERT INTO history_retention_boundaries(chat_id,generation,cleared_through) VALUES(?,?,?)',
            )
            .run(scope.chatId, scope.generation, id),
        );
      expect(store.entries(scope, period, 'day', id)).toHaveLength(0);
      expect(store.current(scope, [claim.id])).toBe(false);
      lifecycleBackend(storage).transaction(scope, (db) =>
        expect(db.prepare('SELECT count(*) FROM messages').pluck().get()).toBe(1),
      );
    } finally {
      clock.mockRestore();
      await storage.close();
    }
  },
);
