import { openStorage, scopeFor } from './helpers/connection-scope.js';
import Database from 'better-sqlite3';
import { expect, test, vi } from 'vitest';
import * as api from '../src/storage/index.js';

import { storageFixture } from './helpers/storage-fixture.js';

const message = { chatId: 'vk:1', userId: 'vk:2', messageId: 'one', authorName: 'Имя', role: 'user', text: 'SECRET-TEXT', timestamp: 0 } as const;
test('публичный цикл сохраняет сообщения и настройки, затем распознаёт duplicate', async () => {
  const fixture = storageFixture();
  const first = await openStorage(fixture.path);
  try {
    await first.messages.append(scopeFor(first, (message).chatId), message);
    await first.chats.create(scopeFor(first, message.chatId), { responseMode: 'normal', enabled: true, createdAt: 0 });
    await first.chats.update(scopeFor(first, message.chatId), { title: 'Сохранённое название' });
    await first.messages.append(scopeFor(first, ({ ...message, role: 'assistant', userId: 'vk:-3', messageId: 'two', text: 'Ответ', replyToMessageId: 'one', timestamp: 1 }).chatId), { ...message, role: 'assistant', userId: 'vk:-3', messageId: 'two', text: 'Ответ', replyToMessageId: 'one', timestamp: 1 });
    await first.close(); await first.close();
    const second = await openStorage(fixture.path);
    try {
      expect(await second.messages.append(scopeFor(second, (message).chatId), message)).toMatchObject({ status: 'duplicate' });
      expect(await second.messages.list(scopeFor(second, message.chatId), { limit: 10 })).toMatchObject([message, { messageId: 'two', role: 'assistant', replyToMessageId: 'one' }]);
      expect(await second.chats.get(scopeFor(second, message.chatId))).toMatchObject({ enabled: true, title: 'Сохранённое название', createdAt: 0 });
    } finally { await second.close(); }
    for (const operation of [
      () => first.messages.append(scopeFor(first, (message).chatId), message), () => first.messages.list(scopeFor(first, message.chatId), { limit: 1 }),
      () => first.chats.get(scopeFor(first, message.chatId)), () => first.chats.create(scopeFor(first, message.chatId), { responseMode: 'active', enabled: true, createdAt: 0 }),
      () => first.chats.update(scopeFor(first, message.chatId), { title: 'Новое' }),
    ]) await expect(operation()).rejects.toMatchObject({ code: 'closed' });
  } finally { await first.close(); fixture.cleanup(); }
});
test('публичный API не выдаёт драйвер, SQL или миграционный механизм', () => {
  expect(Object.keys(api).sort()).toEqual(['StorageError', 'openStorage']);
});
test('ошибки операций скрывают текст/SQL, модуль ничего не выводит', async () => {
  const fixture = storageFixture();
  const output = vi.spyOn(process.stdout, 'write'); const errors = vi.spyOn(process.stderr, 'write');
  const storage = await openStorage(fixture.path);
  try {
    const db = new Database(fixture.path);
    try { db.exec("CREATE TRIGGER fail_message BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'SECRET-SQL'); END"); }
    finally { db.close(); }
    const error: unknown = await storage.messages.append(scopeFor(storage, (message).chatId), message).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'operation_failed', message: 'Storage: operation_failed' });
    expect(error).not.toHaveProperty('cause');
    expect(String(error)).not.toMatch(/SECRET|sqlite|INSERT/);
    expect(output).not.toHaveBeenCalled(); expect(errors).not.toHaveBeenCalled();
  } finally { await storage.close(); output.mockRestore(); errors.mockRestore(); fixture.cleanup(); }
});
test('публичное открытие отклоняет постороннюю схему без изменения данных', async () => {
  const fixture = storageFixture();
  const db = new Database(fixture.path);
  try {
    db.exec("CREATE TABLE old(text); INSERT INTO old VALUES ('SECRET')");
    await expect(openStorage(fixture.path)).rejects.toMatchObject({ code: 'schema_incompatible' });
    expect(db.prepare('SELECT * FROM old').get()).toEqual({ text: 'SECRET' });
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'schema_migrations'").all()).toEqual([]);
  } finally { db.close(); fixture.cleanup(); }
});
