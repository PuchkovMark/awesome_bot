import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { openStorage } from '../src/storage/index';
import { lifecycleBackend } from '../src/storage/lifecycle-store';
import type { ConnectionScope, UserId } from '../src/contracts/index';
import { scopeFor } from './helpers/connection-scope';
import { storageFixture } from './helpers/storage-fixture';

test('выборка и счётчик используют один доступный журнал и исходную границу задания', async () => {
  const files = storageFixture();
  const storage = await openStorage(files.path);
  const db = new Database(files.path);
  try {
    const scope = scopeFor(storage, 'vk:group');
    const other = scopeFor(storage, 'vk:neighbor');
    let sequence = 0;
    async function append(
      text: string,
      timestamp = 10,
      userId: UserId = 'vk:a',
      target: ConnectionScope = scope,
    ) {
      const result = await storage.messages.append(target, {
        chatId: target.chatId,
        userId,
        authorName: 'Саша',
        messageId: String(++sequence),
        role: 'user',
        isGroupChat: true,
        timestamp,
        text,
      });
      return result.id;
    }
    const cleared = await append('маяк');
    const service = await append('маяк');
    const hidden = await append('маяк');
    await append('маяк', 1);
    await append('маяк', 10, 'vk:a', other);
    const first = await append('Маяк "встреча"');
    const second = await append('маяк', 10, 'vk:b');
    const reaction = await append('\tОК ');
    const cutoffId = await append('маяк', 20);
    await append('маяк', 9);
    db.prepare('INSERT INTO history_retention_boundaries VALUES (?,?,?,?)').run(
      scope.chatId,
      scope.generation,
      cleared,
      1,
    );
    db.prepare("UPDATE messages SET purpose='service_notice' WHERE id=?").run(service);
    db.prepare(
      "INSERT INTO personal_deletions(code,chat_id,generation,user_id,request_event,requested_at) VALUES ('test',?,?,'vk:a','hide',0)",
    ).run(scope.chatId, scope.generation);
    db.prepare("INSERT INTO personal_hidden_messages VALUES (?,'test',1)").run(hidden);
    const selection = { kind: 'search', cutoffId, limit: 40, from: 10, to: 20 } as const;
    const read = storage.contextMessages.history;
    const matches = read(scope, { ...selection, query: 'маяк', limit: 1 });
    expect(matches.rows.map((row) => row.id)).toEqual([second]);
    expect(matches.found).toBe(2);
    expect(read(scope, { ...selection, author: 'vk:a' }).rows.map((row) => row.id)).toEqual([
      first,
    ]);
    expect(read(scope, { ...selection, query: 'маяк "встреча"', authorNumber: 1 }).found).toBe(1);
    expect(read(scope, { ...selection, query: 'пусто' })).toMatchObject({ found: 0, rows: [] });
    expect(read(scope, { ...selection, kind: 'period' }).rows.map((row) => row.id)).toEqual([
      reaction,
      second,
      first,
    ]);
    expect(matches.countsCurrent()).toBe(true);
    db.prepare('DELETE FROM messages WHERE id=?').run(first);
    expect(matches.countsCurrent()).toBe(false);
    const life = lifecycleBackend(storage);
    life.ownerDecision(life.begin(scope.chatId), 'new');
    expect(() => read(scope, selection)).toThrow();
    expect(() => matches.countsCurrent()).toThrow();
  } finally {
    db.close();
    await storage.close();
    files.cleanup();
  }
});
