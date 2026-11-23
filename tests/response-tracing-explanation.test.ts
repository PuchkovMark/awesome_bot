import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { createAuthorizationService } from '../src/core/authorization/service';
import { createTraceDiagnostics } from '../src/core/response-tracing/diagnostics';
import { initialTrace } from '../src/storage/trace-store';
import { openStorage } from '../src/storage/index';
import { scopeFor } from './helpers/connection-scope';
import { storageFixture } from './helpers/storage-fixture';

test('сводка выбирает последний доставленный ответ, пропускает уведомление и не копирует текст', async () => {
  const files = storageFixture(),
    storage = await openStorage(files.path),
    db = new Database(files.path);
  const auth = await createAuthorizationService({
    config: { ownerId: 'vk:1', reasonMaxLength: 500, reasonRetentionDays: 90 },
    store: storage.authorization,
  });
  try {
    const chat = 'vk:2000000010',
      scope = scopeFor(storage, chat);
    await storage.chats.create(scope, { responseMode: 'active', enabled: true, createdAt: 1 });
    const owner = auth.context({ scope, userId: 'vk:1', kind: 'owner' });
    const administrator = auth.context({ scope, userId: 'vk:2' });
    await auth.grant(owner, 'vk:2', await auth.confirmMembership(scope, 'vk:2'));
    const now = Date.now();
    for (const [id, reaction, status, expires] of [
      [1, 'answer', 'delivered', now + 100000],
      [2, 'answer', 'unknown', now + 100000],
      [3, 'notice', 'delivered', now + 100000],
      [4, 'answer', 'delivered', now - 1],
    ] as const) {
      const input = await storage.messages.append(scope, {
        chatId: chat,
        messageId: String(id),
        role: 'user',
        userId: 'vk:5',
        authorName: 'ИМЯ_НЕ_ПОКАЗЫВАТЬ',
        text: 'ТЕКСТ_НЕ_ПОКАЗЫВАТЬ',
        timestamp: now - 1000,
      });
      db.prepare(
        `INSERT INTO queue_jobs(id,chat_id,generation,message_id,received_at,expires_at,state,outcome)
        VALUES(?,?,?,?,?,?,'terminal','completed')`,
      ).run(id, chat, scope.generation, input.id, now - 1000, now + 100000);
      const trace = initialTrace({ kind: 'mention', mode: 'active', isGroupChat: true });
      db.prepare('INSERT INTO response_traces VALUES(?,?,?,?,?,?,?,?,?)').run(
        id,
        chat,
        scope.generation,
        input.id,
        now - 1000,
        now - 900,
        expires,
        'completed',
        JSON.stringify({
          ...trace,
          model: { name: 'ВНУТРЕННЕЕ_ИМЯ_МОДЕЛИ', invoked: 'yes' },
          publication: { ...trace.publication, rowId: 'complete', reaction, status },
        }),
      );
    }
    const diagnostics = createTraceDiagnostics({ storage, authorization: auth });
    const result = await diagnostics.explain(administrator);
    expect(result).toMatchObject({
      allowed: true,
      value: { jobId: 1, text: expect.stringContaining('упоминание бота') },
    });
    expect(JSON.stringify(result)).not.toMatch(/НЕ_ПОКАЗЫВАТЬ|ВНУТРЕННЕЕ_ИМЯ/u);
    expect(await diagnostics.explain(administrator, 2)).toEqual({ allowed: true, value: null });
    await storage.chats.update(scope, { enabled: false });
    expect(await diagnostics.explain(administrator)).toEqual({ allowed: false, code: 'disabled' });
    expect(await diagnostics.explain(owner)).toMatchObject({ allowed: true, value: { jobId: 1 } });
  } finally {
    auth.dispose();
    db.close();
    await storage.close();
    files.cleanup();
  }
});
