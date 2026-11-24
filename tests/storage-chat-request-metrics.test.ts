import Database from 'better-sqlite3';
import { expect, test, vi } from 'vitest';
import type { ConnectionScope } from '../src/contracts/index';
import {
  addChatMetrics,
  chatRequestMetricsStore,
  pruneChatMetrics,
  recordChatMetric,
} from '../src/storage/chat-request-metrics-store';
import { openStorage } from '../src/storage/index';
import { lifecycleBackend } from '../src/storage/lifecycle-store';
import { migrate } from '../src/storage/migrate';
import { migrations } from '../src/storage/migrations/index';
import { queueMessage } from './helpers/chat-queue';
import { scopeFor } from './helpers/connection-scope';
import { storageFixture } from './helpers/storage-fixture';

const january = Date.UTC(2026, 0, 1);
const february = Date.UTC(2026, 1, 1);
const december = Date.UTC(2026, 11, 31, 23);
const newYear = Date.UTC(2027, 0, 1);

test('миграция начинает сбор в существующих подключениях, новое пустое поколение имеет свою дату', async () => {
  const files = storageFixture();
  const legacy = new Database(files.path);
  try {
    migrate(legacy, migrations.slice(0, 48));
    legacy.exec(`INSERT INTO chat_connections(chat_id,generation,revision,state) VALUES('vk:1',1,0,'active');
      UPDATE lifecycle_clock SET value=1;
      INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp)
      VALUES('vk:1','1','vk:7','Катя','user','Старое сообщение',0);`);
  } finally {
    legacy.close();
  }
  const before = Date.now();
  const storage = await openStorage(files.path);
  try {
    const through = Date.now();
    const metrics = chatRequestMetricsStore(storage);
    const existing = scopeFor(storage, 'vk:1');
    const migrated = metrics.read(existing, 'day', 0, through);
    expect(migrated.startedAt).toBeGreaterThanOrEqual(before - 1);
    expect(migrated.startedAt).toBeLessThanOrEqual(through + 1);
    expect(migrated.buckets).toEqual([]);
    expect((await storage.messages.list(existing, { limit: 1 }))[0]?.text).toBe('Старое сообщение');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(through + 10);
    try {
      const empty = scopeFor(storage, 'vk:2');
      expect(metrics.read(empty, 'day', 0, Date.now())).toEqual({
        startedAt: through + 10,
        buckets: [],
      });
    } finally {
      clock.mockRestore();
    }
  } finally {
    await storage.close();
    files.cleanup();
  }
});

test('повтор события учитывается один раз, откат удаляет и событие, и оба итога', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(february);
  const storage = await openStorage(':memory:');
  try {
    const scope = scopeFor(storage, 'vk:1');
    const life = lifecycleBackend(storage);
    const message = await storage.messages.append(scope, queueMessage(scope.chatId, '1'));
    const jobId = life.transaction(scope, (db) =>
      Number(
        db
          .prepare(
            `INSERT INTO queue_jobs(chat_id,generation,message_id,received_at,expires_at,state,owner)
       VALUES(?,?,?,?,?,'running','test')`,
          )
          .run(scope.chatId, scope.generation, message.id, february, february + 100)
          .lastInsertRowid,
      ),
    );
    const record = (fail: boolean) =>
      life.transaction(scope, (db) => {
        const result = recordChatMetric(db, scope, jobId, 'main:step:0', february, 'main', {
          steps: 1,
        });
        if (fail) throw Error('Откат тестовой транзакции');
        return result;
      });
    expect(() => record(true)).toThrow();
    const metrics = chatRequestMetricsStore(storage);
    for (const grain of ['hour', 'day'] as const)
      expect(metrics.read(scope, grain, 0, february).buckets).toEqual([]);
    expect(record(false)).toBe(true);
    expect(record(false)).toBe(false);
    for (const grain of ['hour', 'day'] as const)
      expect(metrics.read(scope, grain, 0, february).buckets[0]?.totals.steps).toBe(1n);
  } finally {
    await storage.close();
    clock.mockRestore();
  }
});

test('UTC определяет срок часовых и дневных итогов, новое поколение изолировано от прежнего', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(january);
  const storage = await openStorage(':memory:');
  try {
    const life = lifecycleBackend(storage);
    const metrics = chatRequestMetricsStore(storage);
    const original = scopeFor(storage, 'vk:1');
    const neighbor = scopeFor(storage, 'vk:2');
    const add = (scope: ConnectionScope, at: number) =>
      life.transaction(scope, (db) => addChatMetrics(db, scope, at, 'requests', { requests: 1 }));
    for (const at of [january, february, december]) {
      clock.mockReturnValue(at);
      expect(add(original, at)).toBe(true);
    }
    expect(add(neighbor, december)).toBe(true);
    expect(metrics.read(original, 'hour', 0, december).buckets.map((row) => row.at)).toEqual([
      december,
    ]);
    clock.mockReturnValue(newYear);
    life.transaction(original, (db) => pruneChatMetrics(db, newYear));
    expect(add(original, newYear)).toBe(true);
    expect(metrics.read(original, 'hour', 0, newYear).buckets.map((row) => row.at)).toEqual([
      newYear,
    ]);
    expect(metrics.read(original, 'day', 0, newYear).buckets.map((row) => row.at)).toEqual([
      february,
      Date.UTC(2026, 11, 31),
      newYear,
    ]);
    expect(add(original, january)).toBe(false);
    expect(
      life.transaction(original, (db) =>
        db
          .prepare(
            "SELECT count(*) FROM chat_metrics_buckets WHERE grain='hour' AND bucket_at<? OR grain='day' AND bucket_at<?",
          )
          .pluck()
          .get(newYear, february),
      ),
    ).toBe(0);
    const current = life.ownerDecision(life.begin(original.chatId), 'new');
    expect(current.generation).not.toBe(original.generation);
    expect(() => add(original, newYear)).toThrow('stale_scope');
    expect(metrics.read(current, 'day', 0, newYear)).toEqual({ startedAt: newYear, buckets: [] });
    expect(metrics.read(neighbor, 'day', 0, newYear).buckets[0]?.totals.requests).toBe(1n);
    expect(
      life.transaction(current, (db) =>
        db
          .prepare('SELECT count(*) FROM chat_metrics_buckets WHERE generation=?')
          .pluck()
          .get(original.generation),
      ),
    ).toBe(0);
    life.apply(life.begin(current.chatId), { confidence: 'confirmed', bot: 'absent' });
    clock.mockReturnValue(newYear + 10);
    const invited = scopeFor(storage, current.chatId);
    expect(metrics.read(invited, 'day', 0, newYear + 10)).toEqual({
      startedAt: newYear + 10,
      buckets: [],
    });
  } finally {
    await storage.close();
    clock.mockRestore();
  }
});
