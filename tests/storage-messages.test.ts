import { afterEach, expect, test } from 'vitest';
import type { MessageInput } from '../src/storage/types.js';
import { openConnection, type Connection } from '../src/storage/connection.js';
import { migrate } from '../src/storage/migrate.js';
import { createMessageStore } from '../src/storage/messages.js';
import { storageFixture } from './helpers/storage-fixture.js';

const connections: Connection[] = [];
afterEach(() => { for (const connection of connections.splice(0)) connection.close(); });
async function setup(path = ':memory:') {
  const connection = await openConnection(path, migrate); connections.push(connection);
  return { connection, store: createMessageStore(connection) };
}
const base: MessageInput = { chatId: 'test-a:chat', messageId: '1', userId: 'test-a:user', authorName: 'Имя', role: 'user', text: 'Кот 🐈\nновая строка', timestamp: 10 };
test('запись до настроек, обе роли, reply и буквальный SQL-текст', async () => {
  const { store, connection } = await setup();
  const first = await store.append(base);
  const part1: MessageInput = { ...base, messageId: '2', userId: 'test-a:bot', role: 'assistant', text: "'; DROP TABLE chats; --", replyToMessageId: 'missing' };
  const part2: MessageInput = { ...part1, messageId: '3', text: '' };
  await store.append(part1); await store.append(part2);
  expect(await store.list(base.chatId, { limit: 10 })).toMatchObject([base, part1, part2]);
  expect(first.status).toBe('inserted');
  expect(connection.run((db) => db.prepare('SELECT * FROM chats').all())).toEqual([]);
});
test('дубликат с изменённым текстом не меняет журнал и FTS', async () => {
  const { store, connection } = await setup();
  const first = await store.append(base);
  expect(await store.append({ ...base, text: 'секретныйдубликат' })).toEqual({ status: 'duplicate', id: first.id });
  expect(await store.list(base.chatId, { limit: 10 })).toEqual([{ ...base, id: first.id }]);
  connection.run((db) => {
    expect(db.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?').all('секретныйдубликат')).toEqual([]);
    expect(db.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?').all('Кот')).toHaveLength(1);
  });
});
test('изолированы чаты и платформы даже при одинаковых локальных id', async () => {
  const { store } = await setup();
  for (const chatId of ['test-a:chat', 'test-a:other', 'test-b:chat'] as const) {
    const platform = chatId.split(':')[0];
    expect((await store.append({ ...base, chatId, userId: `${platform}:user`, text: chatId })).status).toBe('inserted');
    expect(await store.list(chatId, { limit: 10 })).toMatchObject([{ chatId, text: chatId }]);
  }
  expect(await store.list('test-b:missing', { limit: 10 })).toEqual([]);
});
test('последнее окно, время важнее вставки, равные времена и полуоткрытые границы', async () => {
  const { store } = await setup();
  for (const [messageId, time] of [['late', 30], ['early', 10], ['same1', 20], ['same2', 20]] as const) {
    await store.append({ ...base, messageId, timestamp: time });
  }
  const ids = async (query: Parameters<typeof store.list>[1]) => (await store.list(base.chatId, query)).map((row) => row.messageId);
  expect(await ids({ limit: 2 })).toEqual(['same2', 'late']);
  expect(await ids({ limit: 10, from: 20, to: 30 })).toEqual(['same1', 'same2']);
  expect(await ids({ limit: 10, to: 20 })).toEqual(['early']);
  expect(await ids({ limit: 10, from: 30 })).toEqual(['late']);
});
test('файловая БД сохраняет записи и распознаёт повтор после открытия', async () => {
  const fixture = storageFixture();
  try {
    const first = await setup(fixture.path); const result = await first.store.append(base); first.connection.close();
    const second = await setup(fixture.path);
    expect(await second.store.append(base)).toEqual({ status: 'duplicate', id: result.id });
    expect(await second.store.list(base.chatId, { limit: 1 })).toMatchObject([base]);
    second.connection.close();
  } finally { fixture.cleanup(); }
});
for (const patch of [
  { chatId: ':bad' }, { userId: 'test-b:user' }, { messageId: '' }, { role: 'system' },
  { timestamp: NaN }, { timestamp: -1 }, { text: null }, { authorName: 1 }, { replyToMessageId: '' },
]) {
  test(`некорректная запись ${JSON.stringify(patch)}`, async () => {
    const { store } = await setup();
    await expect(store.append({ ...base, ...patch } as MessageInput)).rejects.toMatchObject({ code: 'invalid_input' });
  });
}
for (const query of [{}, { limit: 0 }, { limit: -1 }, { limit: 1.5 }, { limit: Infinity }, { limit: 1, from: 20, to: 10 }, { limit: 1, from: 10, to: 10 }, { limit: 1, from: -1 }]) {
  test(`некорректная выборка ${JSON.stringify(query)}`, async () => {
    const { store } = await setup();
    await expect(store.list(base.chatId, query as { limit: number })).rejects.toMatchObject({ code: 'invalid_input' });
  });
}
test('нарушение другого ограничения не маскируется как duplicate', async () => {
  const { store, connection } = await setup();
  connection.run((db) => db.exec("CREATE TRIGGER deny_message BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'SECRET'); END"));
  await expect(store.append(base)).rejects.toMatchObject({ code: 'operation_failed', message: 'Storage: operation_failed' });
});
