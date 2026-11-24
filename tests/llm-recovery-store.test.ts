import Database from 'better-sqlite3';
import { expect, test, vi } from 'vitest';
import { llmRecoveryDefaults, type LlmRecoverySettings } from '../src/core/llm-recovery';
import type { LlmResult } from '../src/llm/types';
import { migrate } from '../src/storage/migrate';
import { migrations } from '../src/storage/migrations/index';
import { openStorage } from '../src/storage/index';
import { queueBackend } from '../src/storage/queue-registry';
import { storageFixture } from './helpers/storage-fixture';

const date = Date.UTC(2026, 10, 24, 12);
const ok = { kind: 'complete', text: 'Ответ', usage: { input: 0, output: 0 } } as const;
const server = { kind: 'error', code: 'server', message: 'Тестовый сбой' } as const;
const network = { kind: 'error', code: 'network', message: 'Тестовый сбой' } as const;
const limited = (retryAt?: number) => ({
  kind: 'error' as const,
  code: 'rate_limit' as const,
  message: 'Тестовый сбой',
  ...(retryAt === undefined ? {} : { retryAt }),
});

async function setup(settings: LlmRecoverySettings = llmRecoveryDefaults) {
  const files = storageFixture();
  const preMigration = new Database(files.path);
  migrate(preMigration, migrations.slice(0, 47));
  preMigration.close();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(date);
  let storage = await openStorage(files.path);
  return {
    owner(token: string, leaseMs = 1_800_000) {
      const store = queueBackend(storage);
      store.acquire(token, leaseMs, 1);
      return {
        recovery: store.llmRecovery(token, settings),
        release: () => store.release(token),
      };
    },
    at(value: number) {
      clock.mockReturnValue(date + value);
    },
    async reopen() {
      await storage.close();
      storage = await openStorage(files.path);
    },
    async close() {
      await storage.close();
      files.cleanup();
      clock.mockRestore();
    },
  };
}

test('миграция, срок Retry-After, перезапуск и поздний успех ранее отправленного вызова', async () => {
  const f = await setup();
  try {
    const old = f.owner('old');
    expect(old.recovery.availability()).toBe('available');
    const first = old.recovery.begin()!;
    const late = old.recovery.begin()!;
    old.recovery.finish(first, limited(date + 7_000));
    old.recovery.finish(late, ok);
    expect(old.recovery.begin()).toBeNull();
    old.release();
    await f.reopen();
    const { recovery } = f.owner('new');
    f.at(6_999);
    expect(recovery.availability()).toBe('paused');
    f.at(7_000);
    expect(recovery.availability()).toBe('available');
    const probe = recovery.begin()!;
    expect(probe.probe).toBe(true);
    expect(recovery.availability()).toBe('probing');
    expect(recovery.begin()).toBeNull();
    recovery.finish(probe, ok);
    expect(recovery.begin()?.probe).toBe(false);
  } finally {
    await f.close();
  }
});

test('окно 5xx скользит, успех прерывает серию, граница окна исключает первую ошибку', async () => {
  const f = await setup();
  try {
    const { recovery } = f.owner('owner');
    const respond = (time: number, result: LlmResult) => {
      f.at(time);
      recovery.finish(recovery.begin()!, result);
    };
    respond(0, server);
    respond(1_000, server);
    respond(2_000, ok);
    respond(3_000, server);
    respond(32_000, server);
    respond(33_000, server);
    expect(recovery.availability()).toBe('available');
    respond(34_000, server);
    expect(recovery.availability()).toBe('paused');
    f.at(64_000);
    expect(recovery.begin()?.probe).toBe(true);
  } finally {
    await f.close();
  }
});

test.each(['до срока', 'после срока'] as const)(
  'запоздалый Retry-After сохраняет единственную проверку, завершившуюся %s',
  async (finished) => {
    const f = await setup();
    try {
      const { recovery } = f.owner('owner');
      const trigger = recovery.begin()!;
      const oldWithZero = recovery.begin()!;
      const oldWithLongerDeadline = recovery.begin()!;
      recovery.finish(trigger, limited(date + 50));
      f.at(50);
      const probe = recovery.begin()!;
      f.at(60);
      recovery.finish(oldWithZero, limited(date + 60));
      expect(recovery.availability()).toBe('probing');
      expect(recovery.begin()).toBeNull();
      recovery.finish(oldWithLongerDeadline, limited(date + 120));
      expect(recovery.availability()).toBe('paused');
      if (finished === 'до срока') {
        recovery.finish(probe, ok);
        expect(recovery.begin()).toBeNull();
        f.at(120);
        expect(recovery.begin()?.probe).toBe(true);
      } else {
        f.at(120);
        expect(recovery.availability()).toBe('probing');
        expect(recovery.begin()).toBeNull();
        recovery.finish(probe, ok);
        expect(recovery.begin()?.probe).toBe(false);
      }
    } finally {
      await f.close();
    }
  },
);

test('проверочные сбои дают 30, 60, 120, 240 и 300 секунд, более долгий срок провайдера сохраняется', async () => {
  const f = await setup();
  try {
    const { recovery } = f.owner('owner');
    recovery.finish(recovery.begin()!, limited());
    let at = 0;
    for (const delay of [30_000, 60_000, 120_000, 240_000, 300_000]) {
      at += delay;
      f.at(at - 1);
      expect(recovery.availability()).toBe('paused');
      f.at(at);
      const probe = recovery.begin()!;
      expect(probe.probe).toBe(true);
      recovery.finish(probe, delay === 300_000 ? limited(date + at + 400_000) : server);
    }
    f.at(at + 399_999);
    expect(recovery.availability()).toBe('paused');
    f.at(at + 400_000);
    const probe = recovery.begin()!;
    recovery.finish(probe, network);
    const next = recovery.begin()!;
    recovery.finish(next, undefined);
    expect(recovery.begin()?.probe).toBe(true);
  } finally {
    await f.close();
  }
});

test('новый владелец проверяет провайдера после прерванной попытки, прежний результат отклоняется', async () => {
  const f = await setup({
    failureThreshold: 2,
    failureWindowMs: 200,
    initialPauseMs: 5,
    maxPauseMs: 15,
  });
  try {
    const { recovery: former } = f.owner('old', 100);
    former.finish(former.begin()!, server);
    former.finish(former.begin()!, server);
    f.at(4);
    expect(former.availability()).toBe('paused');
    f.at(5);
    const abandoned = former.begin()!;
    expect(abandoned.probe).toBe(true);
    f.at(100);
    const { recovery } = f.owner('new');
    const replacement = recovery.begin()!;
    expect(replacement.probe).toBe(true);
    expect(() => former.finish(abandoned, ok)).toThrow('queue_lost_ownership');
    recovery.finish(replacement, server);
    f.at(109);
    expect(recovery.availability()).toBe('paused');
    f.at(110);
    const next = recovery.begin()!;
    recovery.finish(next, server);
    f.at(124);
    expect(recovery.availability()).toBe('paused');
    f.at(125);
    recovery.finish(recovery.begin()!, ok);
    expect(recovery.begin()?.probe).toBe(false);
  } finally {
    await f.close();
  }
});
