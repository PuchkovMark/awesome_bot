import { expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import { openStorage } from '../src/storage/index';
import { queueBackend } from '../src/storage/queue-registry';
import { queueConfig } from '../src/core/chat-queue/validation';
import { scopeFor } from './helpers/connection-scope';
import { storageFixture } from './helpers/storage-fixture';
const message = (id: string) => ({
  chatId: 'vk:a' as const,
  userId: 'vk:u' as const,
  messageId: id,
  authorName: 'private',
  role: 'user' as const,
  text: 'кот',
  timestamp: 0,
});
test('атомарность, дубль после переполнения, независимый журнал, изоляция ссылки', async () => {
  const f = storageFixture(),
    storage = await openStorage(f.path),
    db = new Database(f.path);
  try {
    const q = queueBackend(storage),
      scope = scopeFor(storage, 'vk:a');
    q.acquire('owner', 30000, 10000);
    const config = queueConfig({ maxQueuedPerChat: 1 });
    const first = q.admit('owner', scope, message('1'), () => true, config);
    expect(first.status).toBe('queued');
    expect(q.admit('owner', scope, message('2'), () => true, config).status).toBe('queue_full');
    expect(await storage.messages.list(scope, { limit: 10 })).toHaveLength(2);
    db.exec('DELETE FROM queue_jobs');
    expect(q.admit('owner', scope, message('2'), () => true, config).status).toBe('duplicate');
    expect(q.admit('owner', scope, message('1'), () => true, config).status).toBe('duplicate');
    db.exec(
      "CREATE TRIGGER bad_queue BEFORE INSERT ON queue_jobs BEGIN SELECT RAISE(ABORT,'private');END",
    );
    expect(() => q.admit('owner', scope, message('3'), () => true, config)).toThrow(
      'operation_failed',
    );
    expect(await storage.messages.list(scope, { limit: 10 })).toHaveLength(2);
    db.exec('DROP TRIGGER bad_queue');
    expect(() =>
      q.admit(
        'owner',
        scope,
        message('4'),
        // @ts-expect-error Проверяем недоверенный runtime-ввод, Promise запрещён контрактом.
        async () => {
          throw Error('private');
        },
        config,
      ),
    ).toThrow('invalid_input');
    expect(await storage.messages.list(scope, { limit: 10 })).toHaveLength(2);
    const b = scopeFor(storage, 'vk:b');
    if (first.status === 'queued')
      expect(await storage.messages.get(b, first.messageId)).toBeNull();
    q.release('owner');
  } finally {
    db.close();
    await storage.close();
    f.cleanup();
  }
});
test('решение видит вставленный неизменяемый журнал; исключение откатывает', async () => {
  const storage = await openStorage(':memory:');
  try {
    const scope = scopeFor(storage, 'vk:a'),
      q = queueBackend(storage);
    q.acquire('o', 30000, 10000);
    const decision = vi.fn((input) => {
      expect(Object.isFrozen(input)).toBe(true);
      expect(Object.isFrozen(input.message)).toBe(true);
      return false;
    });
    expect(q.admit('o', scope, message('1'), decision, queueConfig()).status).toBe('not_needed');
    expect(() =>
      q.admit(
        'o',
        scope,
        message('2'),
        () => {
          throw Error('private');
        },
        queueConfig(),
      ),
    ).toThrow('operation_failed');
    expect(await storage.messages.list(scope, { limit: 10 })).toHaveLength(1);
    q.release('o');
  } finally {
    await storage.close();
  }
});

test('принятая постановка выдаёт jobId для scoped-чтения, отдельно от ссылки журнала', async () => {
  const storage = await openStorage(':memory:');
  try {
    const scope = scopeFor(storage, 'vk:a'),
      q = queueBackend(storage);
    q.acquire('o', 30000, 10000);
    q.admit('o', scope, message('journal-only'), () => false, queueConfig());
    const admitted = q.admit('o', scope, message('queued'), () => true, queueConfig());
    expect(admitted.status).toBe('queued');
    if (admitted.status === 'queued') {
      expect(admitted.messageId).not.toBe(admitted.jobId);
      expect(await storage.queue.get(scope, admitted.jobId)).toMatchObject({
        id: admitted.jobId,
        messageId: admitted.messageId,
        state: 'queued',
      });
    }
    q.release('o');
  } finally {
    await storage.close();
  }
});
