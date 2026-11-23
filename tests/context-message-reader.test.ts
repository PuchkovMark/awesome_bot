import { expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import { openStorage } from '../src/storage/index';
import { scopeFor } from './helpers/connection-scope';
import { storageFixture } from './helpers/storage-fixture';
test('полный журнал сохраняет notice, контекст фильтрует до limit и get/reply; FTS rebuild безопасен', async () => {
  const f = storageFixture(),
    s = await openStorage(f.path),
    scope = scopeFor(s, 'vk:a'),
    db = new Database(f.path);
  try {
    const first = await s.messages.append(scope, {
      chatId: 'vk:a',
      messageId: 'a',
      userId: 'vk:u',
      authorName: '',
      role: 'user',
      text: 'обычныйкот',
      timestamp: 0,
    });
    db.exec(
      "INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp,purpose) VALUES('vk:a','n','vk:bot','','assistant','уведомлениекот',1,'service_notice')",
    );
    const all = await s.messages.list(scope, { limit: 2 });
    expect(all).toHaveLength(2);
    expect(all[1]?.purpose).toBe('service_notice');
    expect(await s.contextMessages.list(scope, { limit: 1 })).toMatchObject([{ id: first.id }]);
    expect(await s.contextMessages.get(scope, all[1]!.id)).toBeNull();
    expect(await s.contextMessages.reply(scope, 'n', all[1]!.id, 100)).toBeNull();
    expect(
      await s.contextMessages.page(scope, { cutoffId: all[1]!.id, limit: 1, textLimit: 100 }),
    ).toMatchObject([{ id: first.id }]);
    db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
    expect(
      db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'уведомлениекот'").all(),
    ).toEqual([]);
    await expect(
      s.messages.append(scope, {
        chatId: 'vk:a',
        messageId: 'bad',
        userId: 'vk:u',
        authorName: '',
        role: 'user',
        text: '',
        timestamp: 0,
        purpose: 'service_notice',
      } as never),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  } finally {
    db.close();
    await s.close();
    f.cleanup();
  }
});

test('запросная область связывает метки с исходными авторами и читает страницу одним SELECT', async () => {
  const f = storageFixture();
  const s = await openStorage(f.path);
  const db = new Database(f.path);
  try {
    const scope = scopeFor(s, 'vk:a');
    const other = scopeFor(s, 'vk:b');
    const record = {
      authorName: 'Саша Иванов',
      isGroupChat: true,
      role: 'user' as const,
      text: 'Большая синтетическая реплика',
      timestamp: 2,
    };
    const first = await s.messages.append(scope, {
      ...record,
      chatId: scope.chatId,
      messageId: 'first',
      userId: 'vk:1',
    });
    const second = await s.messages.append(scope, {
      ...record,
      chatId: scope.chatId,
      messageId: 'second',
      userId: 'vk:2',
      replyToMessageId: 'first',
    });
    await s.messages.append(other, {
      ...record,
      chatId: other.chatId,
      messageId: 'first',
      userId: 'vk:2',
    });
    expect(await s.contextMessages.get(scope, second.id)).toMatchObject({
      authorName: 'Саша Иванов',
      authorNumber: 2,
      userId: 'vk:2',
    });
    expect(await s.contextMessages.reply(scope, 'first', second.id, 6)).toMatchObject({
      authorNumber: 1,
      userId: 'vk:1',
      truncated: true,
    });
    expect(await s.contextMessages.reply(other, 'first', second.id + 1, 100)).toMatchObject({
      authorNumber: 1,
      userId: 'vk:2',
    });
    expect(await s.contextMessages.get(other, first.id)).toBeNull();

    let cutoffId = second.id;
    for (let i = 3; i <= 80; i++) {
      const inserted = await s.messages.append(scope, {
        ...record,
        chatId: scope.chatId,
        messageId: String(i),
        userId: `vk:${i}`,
      });
      cutoffId = inserted.id;
    }
    const spy = vi.spyOn(Database.prototype, 'prepare');
    try {
      const page = (limit: number) =>
        s.contextMessages.page(scope, { cutoffId, limit, textLimit: 100 });
      expect(await page(2)).toHaveLength(2);
      const statements = spy.mock.calls.length;
      spy.mockClear();
      const rows = await page(80);
      expect(rows.map(({ authorNumber }) => authorNumber)).toEqual(
        Array.from({ length: 80 }, (_, i) => 80 - i),
      );
      expect(spy.mock.calls).toHaveLength(statements);
      expect(
        spy.mock.calls.filter(([sql]) => sql.includes('LEFT JOIN chat_author_labels')),
      ).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
    db.prepare('DELETE FROM messages WHERE id=?').run(first.id);
    expect(await s.contextMessages.reply(scope, 'first', cutoffId, 100)).toBeNull();
    expect(await s.contextMessages.get(scope, second.id)).toMatchObject({ authorNumber: 2 });
  } finally {
    db.close();
    await s.close();
    f.cleanup();
  }
});
