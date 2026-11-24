import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { expect, test, vi } from 'vitest';
import type { ChatId, ConnectionScope, ConnectionVersion } from '../src/contracts/index';
import { createLifecycleService } from '../src/core/index';
import { openStorage, type Storage } from '../src/storage/index';
import { storageFixture } from './helpers/storage-fixture';

const ownerId = 'vk:73';
const first = 'vk:2000000001';
const second = 'vk:2000000002';

function lifecycle(storage: Storage) {
  return createLifecycleService({
    storage,
    ownerId,
    source: {
      async observe() {
        return { confidence: 'unavailable', bot: 'unknown' };
      },
    },
  });
}

async function record(storage: Storage, scope: ConnectionScope, id: string) {
  await storage.messages.append(scope, {
    chatId: scope.chatId,
    messageId: id,
    userId: 'vk:19',
    authorName: '',
    role: 'user',
    text: 'Синтетическая история',
    timestamp: Date.now(),
  });
}

test('снимок доступен только владельцу и выбирает только приостановленные подключения платформы', async () => {
  const storage = await openStorage(':memory:');
  try {
    const life = lifecycle(storage);
    expect(life.pausedConnections('vk', ownerId)).toEqual([]);
    await life.verify(second, 'first_seen');
    await life.verify(first, 'observation_lost');
    await life.verify('other:1', 'startup');
    life.decide(life.owner('vk:4', ownerId), 'new');
    const list = life.pausedConnections('vk', ownerId);
    expect(list).toEqual([
      { chatId: first, generation: 2, revision: 0, reason: 'observation_lost', title: null },
      { chatId: second, generation: 1, revision: 0, reason: 'first_seen', title: null },
    ]);
    expect(life.pausedConnections('other', ownerId)).toHaveLength(1);
    expect(() => life.pausedConnections('vk', 'vk:1')).toThrow('forbidden');
    expect(() => life.decidePaused(list[0]!, 'vk:1', 'new')).toThrow('forbidden');
    expect(life.pausedConnections('vk', ownerId)).toEqual(list);
  } finally {
    await storage.close();
  }
});

test('продолжение сохраняет историю, новая причина делает строку устаревшей, сброс действует только один раз', async () => {
  const file = storageFixture();
  const storage = await openStorage(file.path);
  try {
    const life = lifecycle(storage);
    const open = (chatId: ChatId) => life.decide(life.owner(chatId, ownerId), 'new');
    const preserved = open(first);
    const removed = open(second);
    await record(storage, preserved, '1');
    await record(storage, removed, '2');
    await life.verify(first, 'observation_lost');
    await life.verify(second, 'observation_lost');
    const [keep, oldReset] = life.pausedConnections('vk', ownerId);
    life.recordConnectionSignal(second, '3');
    const reset = life.pausedConnections('vk', ownerId)[1]!;
    expect(reset).toMatchObject({ reason: 'membership_signal', revision: oldReset!.revision + 1 });
    expect(life.recordConnectionSignal(second, '3')).toEqual({ status: 'duplicate' });
    expect(life.pausedConnections('vk', ownerId)[1]).toEqual(reset);
    await life.verify(second);
    expect(life.pausedConnections('vk', ownerId)[1]).toEqual(reset);
    expect(() => life.decidePaused(oldReset!, ownerId, 'new')).toThrow('stale_scope');
    const resumed = life.decidePaused(keep!, ownerId, 'continue');
    expect(resumed.generation).toBe(preserved.generation);
    expect(await storage.messages.list(resumed, { limit: 5 })).toMatchObject([{ messageId: '1' }]);
    expect(() => life.decidePaused(keep!, ownerId, 'new')).toThrow('stale_scope');
    const fresh = life.decidePaused(reset, ownerId, 'new');
    expect(fresh.generation).not.toBe(removed.generation);
    expect(await storage.messages.list(fresh, { limit: 5 })).toEqual([]);
    await record(storage, fresh, '3');

    const reopened = await openStorage(file.path);
    try {
      const other = lifecycle(reopened);
      expect(other.pausedConnections('vk', ownerId)).toEqual([]);
      expect(() => other.decidePaused(reset, ownerId, 'new')).toThrow('stale_scope');
      expect(await reopened.messages.list(other.current(second), { limit: 5 })).toMatchObject([
        { messageId: '3' },
      ]);
      await other.verify(second, 'startup');
      const [current] = other.pausedConnections('vk', ownerId);
      expect(current).toMatchObject({ reason: 'startup', generation: fresh.generation });
      expect(() =>
        other.decidePaused({ ...current!, generation: reset.generation }, ownerId, 'new'),
      ).toThrow('stale_scope');
    } finally {
      await reopened.close();
    }
  } finally {
    await storage.close();
    file.cleanup();
  }
});

function contender(path: string, selected: ConnectionVersion, decision: 'new' | 'continue') {
  const worker = new Worker(
    `
    const { parentPort, workerData } = require('node:worker_threads');
    async function prepare() {
      const { path, ownerId, selected, decision, storageModule, lifecycleModule } = workerData;
      const { openStorage } = await import(storageModule);
      const { createLifecycleService } = await import(lifecycleModule);
      const storage = await openStorage(path);
      const life = createLifecycleService({ storage, ownerId, source: {} });
      parentPort.once('message', async () => {
        let result;
        try {
          result = life.decidePaused(selected, ownerId, decision).generation;
        } catch (error) {
          if (error.code !== 'stale_scope') throw error;
          result = error.code;
        } finally {
          await storage.close();
        }
        parentPort.postMessage(result);
      });
      parentPort.postMessage('ready');
    }
    prepare().catch((error) => { throw error; });
    `,
    {
      eval: true,
      workerData: {
        path,
        ownerId,
        selected,
        decision,
        storageModule: pathToFileURL(resolve('dist/storage/index.js')).href,
        lifecycleModule: pathToFileURL(resolve('dist/core/lifecycle/service.js')).href,
      },
    },
  );
  const ready = Promise.withResolvers<void>();
  const result = Promise.withResolvers<number | string>();
  worker.once('error', (error) => {
    ready.reject(error);
    result.reject(error);
  });
  worker.on('message', (message: number | string) => {
    if (message === 'ready') ready.resolve();
    else result.resolve(message);
  });
  return { worker, ready: ready.promise, result: result.promise };
}

test('два соединения SQLite применяют ровно одно из противоположных решений по одной строке', async () => {
  const file = storageFixture();
  const storage = await openStorage(file.path);
  const contenders: ReturnType<typeof contender>[] = [];
  try {
    const life = lifecycle(storage);
    const scope = life.decide(life.owner(first, ownerId), 'new');
    await record(storage, scope, '1');
    await life.verify(first, 'observation_lost');
    const [row] = life.pausedConnections('vk', ownerId);
    contenders.push(contender(file.path, row!, 'new'), contender(file.path, row!, 'continue'));
    const [, outcomes] = await Promise.all([
      Promise.all(contenders.map(({ ready }) => ready)).then(() => {
        for (const { worker } of contenders) worker.postMessage('go');
      }),
      Promise.all(contenders.map(({ result }) => result)),
    ]);
    const active = life.current(first);
    expect(outcomes).toEqual(expect.arrayContaining([active.generation, 'stale_scope']));
    expect(await storage.messages.list(active, { limit: 5 })).toHaveLength(
      active.generation === scope.generation ? 1 : 0,
    );
  } finally {
    await Promise.all(contenders.map(({ worker }) => worker.terminate()));
    await storage.close();
    file.cleanup();
  }
});

test('сброс связан с доставленным предупреждением, его сроком и версией беседы', async () => {
  const file = storageFixture();
  const storage = await openStorage(file.path);
  const clock = vi.spyOn(Date, 'now');
  try {
    clock.mockReturnValue(1000);
    const life = lifecycle(storage);
    await life.verify(first, 'first_seen');
    const row = life.pausedConnections('vk', ownerId)[0]!;
    const request = life.requestPausedReset(row, ownerId, 1);
    expect(life.requestPausedReset(row, ownerId, 1).code).toBe(request.code);
    expect(() => life.answerPausedReset(ownerId, request.code, 2, true)).toThrow('stale_scope');
    clock.mockReturnValue(1000000);
    expect(life.resetWarningDelivered(ownerId, request.code, 3)).toBe(true);
    expect(() => life.answerPausedReset('vk:4', request.code, 4, true)).toThrow('forbidden');
    clock.mockReturnValue(1900000);
    expect(() => life.answerPausedReset(ownerId, request.code, 5, true)).toThrow('stale_scope');
    const old = life.requestPausedReset(row, ownerId, 6);
    expect(life.resetWarningDelivered(ownerId, old.code, 7)).toBe(true);
    life.recordConnectionSignal(row.chatId, 'смена');
    expect(() => life.answerPausedReset(ownerId, old.code, 8, true)).toThrow('stale_scope');
    const current = life.pausedConnections('vk', ownerId)[0]!;
    const last = life.requestPausedReset(current, ownerId, 9);
    expect(life.resetWarningDelivered(ownerId, last.code, 10)).toBe(true);
    const reopened = await openStorage(file.path);
    try {
      const secondLife = lifecycle(reopened);
      const results = await Promise.all(
        [life, secondLife].map((service, index) =>
          Promise.resolve().then(() =>
            service.answerPausedReset(ownerId, last.code, 11 + index, true),
          ),
        ),
      );
      expect(results).toEqual([
        { chatId: first, state: 'confirmed' },
        { chatId: first, state: 'confirmed' },
      ]);
      expect(life.current(first).generation).toBe(secondLife.current(first).generation);
      expect(life.current(first).generation).not.toBe(row.generation);
    } finally {
      await reopened.close();
    }
  } finally {
    clock.mockRestore();
    await storage.close();
    file.cleanup();
  }
});
