import Database from 'better-sqlite3';
import { expect, test, vi } from 'vitest';
import type { ConnectionScope } from '../src/contracts/index';
import { queueConfig } from '../src/core/chat-queue/validation';
import { disclosureStore } from '../src/storage/chat-disclosure-store';
import { groupReplyGateStore } from '../src/storage/group-reply-gate-store';
import { migrate } from '../src/storage/migrate';
import { migrations } from '../src/storage/migrations/index';
import { queueBackend } from '../src/storage/queue-registry';
import { reconcileRestoredWork } from '../src/storage/restore-work';
import { tokenBudgetStore } from '../src/storage/token-budget-store';
import { openStorage, scopeFor } from './helpers/connection-scope';
import { alice, group, neighbor, profileFixture } from './helpers/profile-fact-fixture';

const config = queueConfig({ maxQueuedPerChat: 1 });
const lease = 'assessment-test';
const candidate = {
  kind: 'name',
  mode: 'normal',
  forwarded: false,
  otherAddress: false,
} as const;
type Fixture = Awaited<ReturnType<typeof profileFixture>>;

function submit(
  storage: Fixture['storage'],
  scope: ConnectionScope,
  id: string,
  time = Date.now(),
) {
  return queueBackend(storage).admitRouted(
    lease,
    scope,
    {
      chatId: scope.chatId,
      userId: alice,
      messageId: id,
      authorName: 'Тестовый участник',
      role: 'user',
      text: 'Пенёк посчитай',
      timestamp: time,
      senderBot: false,
      isGroupChat: true,
    },
    () => ({ route: null, reason: 'assessment', assessment: candidate }),
    config,
    () => ({ journal: true, respond: true, version: disclosureStore(storage).gate(scope).version }),
  );
}

test('ожидание связано с записанной репликой и одной попыткой даже при двух приёмах', async () => {
  const f = await profileFixture();
  let second: Fixture['storage'] | undefined;
  try {
    const scope = await f.chat(),
      other = await f.chat(neighbor);
    f.deliver(scope);
    f.deliver(other);
    second = await openStorage(f.path);
    const queue = queueBackend(f.storage);
    queue.acquire(lease, 30_000, 10_000);
    const otherConnection = scopeFor(second, group);
    const [a, b] = await Promise.all([
      Promise.resolve().then(() => submit(f.storage, scope, '201')),
      Promise.resolve().then(() => submit(second!, otherConnection, '201')),
    ]);
    expect([a.admission.status, b.admission.status].sort()).toEqual(['duplicate', 'not_needed']);
    const selected = groupReplyGateStore(f.storage).next('vk', Date.now())!;
    expect(selected).toMatchObject({ state: 'waiting', chatId: scope.chatId });
    expect((await f.storage.messages.get(scope, selected.messageId))?.text).toBe('Пенёк посчитай');
    expect(groupReplyGateStore(f.storage).valid(other, selected.messageId, Date.now())).toBeNull();
    const store = groupReplyGateStore(f.storage);
    expect(
      store.reserve(scope, selected.messageId, 'try-one', [], selected.messageId, Date.now(), {
        input: 10,
        output: 5,
      }),
    ).toBe(true);
    expect(
      groupReplyGateStore(second).reserve(
        otherConnection,
        selected.messageId,
        'try-two',
        [],
        selected.messageId,
        Date.now(),
        { input: 10, output: 5 },
      ),
    ).toBe(false);
    expect(store.sent(scope, selected.messageId, 'try-one', Date.now())).toBe(true);
    expect(store.finish(scope, selected.messageId, 'try-one', 'answer', 20, Date.now())).toBe(true);
    const full = queueConfig({ maxQueuedTotal: 1, maxQueuedPerChat: 1 });
    expect(
      queue.admit(
        lease,
        other,
        {
          chatId: other.chatId,
          userId: alice,
          messageId: '202',
          authorName: 'Участник',
          role: 'user',
          text: 'Прямое задание другой беседы',
          timestamp: Date.now(),
        },
        () => true,
        full,
      ).status,
    ).toBe('queued');
    expect(queue.promoteGroupReply(lease, scope, selected.messageId, full)).toBe('full');
    expect(store.valid(scope, selected.messageId, Date.now())?.state).toBe('approved');
    expect(queue.take(lease)?.scope.chatId).toBe(other.chatId);
    expect(queue.promoteGroupReply(lease, scope, selected.messageId, config)).toBe('queued');
    expect(queue.promoteGroupReply(lease, scope, selected.messageId, config)).toBe('closed');
    expect(queue.take(lease)).toMatchObject({
      messageId: selected.messageId,
      route: { kind: 'name' },
    });
  } finally {
    await second?.close();
    await f.close();
  }
});

test('неотправленная оценка восстанавливается, неопределённая закрывается и не занимает очередь ответов', async () => {
  const f = await profileFixture();
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  try {
    const scope = await f.chat();
    f.deliver(scope);
    const queue = queueBackend(f.storage);
    queue.acquire(lease, 30000, 10000);
    for (const id of ['201', '202', '203'])
      expect(submit(f.storage, scope, id).admission.status).toBe('not_needed');
    let store = groupReplyGateStore(f.storage);
    const first = store.next('vk', now)!;
    const second = store.next('vk', now, [first.messageId])!;
    expect(store.next('vk', now, [first.messageId, second.messageId])).toBeUndefined();
    expect(queue.depth(lease).depthQueued).toBe(0);
    expect(
      store.reserve(scope, first.messageId, 'a', [], first.messageId, now, {
        input: 10,
        output: 5,
      }),
    ).toBe(true);
    expect(store.sent(scope, first.messageId, 'a', now)).toBe(true);
    expect(
      store.reserve(scope, second.messageId, 'b', [], second.messageId, now, {
        input: 10,
        output: 5,
      }),
    ).toBe(true);
    queue.release(lease);
    await f.reopen();
    const restored = scopeFor(f.storage, group);
    store = groupReplyGateStore(f.storage);
    store.recover('vk');
    expect(store.valid(restored, first.messageId, now)).toMatchObject({
      state: 'finished',
      outcome: 'uncertain',
    });
    expect(store.next('vk', now)).toMatchObject({
      messageId: second.messageId,
      state: 'waiting',
      attemptKey: null,
    });
    expect(tokenBudgetStore(f.storage).read(restored, true, now).total.reserved).toBe(15n);
    expect(store.reconcile(restored, 'a', { input: 3, output: 1 })).toBe(true);
    expect(tokenBudgetStore(f.storage).read(restored, true, now).total).toMatchObject({
      reserved: 0n,
      confirmed: 4n,
    });
    expect(store.next('vk', second.expiresAt)).toBeUndefined();
  } finally {
    clock.mockRestore();
    await f.close();
  }
});

test('копия до оценки сверяет исход из живой базы и завершённый ответ не допускает повтор', async () => {
  const f = await profileFixture();
  const path = f.path + '.snapshot';
  try {
    const scope = await f.chat(),
      other = await f.chat(neighbor);
    f.deliver(scope);
    f.deliver(other);
    const queue = queueBackend(f.storage);
    queue.acquire(lease, 30000, 10000);
    submit(f.storage, scope, '201');
    submit(f.storage, other, '201');
    const store = groupReplyGateStore(f.storage);
    const attempt = store.next('vk', Date.now())!;
    const newer = new Database(f.path);
    try {
      await newer.backup(path);
      expect(
        store.reserve(scope, attempt.messageId, 'known', [], attempt.messageId, Date.now(), {
          input: 10,
          output: 5,
        }),
      ).toBe(true);
      expect(store.sent(scope, attempt.messageId, 'known', Date.now())).toBe(true);
      expect(store.finish(scope, attempt.messageId, 'known', 'answer', 15, Date.now())).toBe(true);
      expect(queue.promoteGroupReply(lease, scope, attempt.messageId, config)).toBe('queued');
      newer
        .prepare("UPDATE queue_jobs SET state='terminal',outcome='completed' WHERE message_id=?")
        .run(attempt.messageId);

      const staged = new Database(path);
      try {
        staged.pragma('foreign_keys=ON');
        staged.transaction(() => reconcileRestoredWork(staged, newer, Date.now()))();
        expect(
          staged
            .prepare(
              'SELECT chat_id,state,outcome FROM group_reply_assessments ORDER BY message_id',
            )
            .all(),
        ).toEqual([
          { chat_id: group, state: 'finished', outcome: 'answer' },
          { chat_id: neighbor, state: 'waiting', outcome: null },
        ]);
        expect(staged.prepare('SELECT count(*) FROM queue_jobs').pluck().get()).toBe(0);
        expect(staged.pragma('foreign_key_check')).toEqual([]);
      } finally {
        staged.close();
      }
    } finally {
      newer.close();
    }
  } finally {
    await f.close();
  }
});

test('миграция 63 сохраняет учтённый расход и убирает прежние ожидания без работы по журналу', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys=ON');
    migrate(db, migrations.slice(0, 62));
    db.exec(`INSERT INTO chat_connections(chat_id,generation,revision,state) VALUES ('vk:2000000043',1,0,'active');
      INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp)
        VALUES ('vk:2000000043','1','vk:41','','user','Во сколько встреча?',1);
      INSERT INTO autonomous_questions VALUES (1,'vk:2000000043',1,10,100,0,0,NULL);
      INSERT INTO token_budget_attempts VALUES ('vk:2000000043',1,'previous',1,'initiative',100,40,81,11);
      INSERT OR IGNORE INTO chat_metrics_collection VALUES ('vk:2000000043',1,0);
      INSERT INTO chat_metrics_attempts VALUES ('vk:2000000043',1,'previous',1,'initiative_main',81,11,0);
      INSERT INTO chat_metrics_buckets(chat_id,generation,grain,bucket_at,series,input_tokens,output_tokens)
        VALUES ('vk:2000000043',1,'hour',0,'initiative_main',81,11);
    `);
    const tables = [
      'schema_migrations',
      'token_budget_attempts',
      'chat_metrics_attempts',
      'chat_metrics_buckets',
    ];
    const rows = (table: string) =>
      db
        .prepare(
          'SELECT * FROM ' + table + (table === 'schema_migrations' ? ' WHERE version<=62' : ''),
        )
        .all();
    const saved = tables.map(rows);
    migrate(db);
    expect(tables.map(rows)).toEqual(saved);
    expect(db.prepare('SELECT * FROM autonomous_questions').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM group_reply_assessments').all()).toEqual([]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
  }
});
