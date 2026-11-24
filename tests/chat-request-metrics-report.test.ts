import { expect, test, vi } from 'vitest';
import type { ConnectionScope } from '../src/contracts/index';
import type { MetricDelta, MetricsSeries } from '../src/contracts/chat-metrics';
import { createAuthorizationService, createChatRequestMetrics } from '../src/core/index';
import type { ChatMetricsPeriod } from '../src/core/index';
import { addChatMetrics, chatRequestMetricsStore } from '../src/storage/chat-request-metrics-store';
import { openStorage } from '../src/storage/index';
import { lifecycleBackend } from '../src/storage/lifecycle-store';
import { scopeFor } from './helpers/connection-scope';

const hour = 3_600_000;
const at = (day: number, hours = 0, minutes = 0) => Date.UTC(2026, 0, day, hours, minutes);
const ownerId = 'vk:owner';
const settings = { ownerId, reasonMaxLength: 100, reasonRetentionDays: 5 } as const;

test('четыре периода UTC показывают точки, взвешенные средние и раздельный расход двух бесед', async () => {
  const began = Date.UTC(2025, 11, 28, 23, 30);
  const through = at(2, 2, 30);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(began);
  const storage = await openStorage(':memory:');
  const authorization = await createAuthorizationService({
    config: settings,
    store: storage.authorization,
  });
  try {
    const first = scopeFor(storage, 'vk:one');
    await storage.chats.create(first, { enabled: true, responseMode: 'normal', createdAt: began });
    const life = lifecycleBackend(storage);
    const add = (
      scope: ConnectionScope,
      time: number,
      series: MetricsSeries,
      delta: MetricDelta,
    ) => {
      clock.mockReturnValue(time);
      expect(life.transaction(scope, (db) => addChatMetrics(db, scope, time, series, delta))).toBe(
        true,
      );
    };
    const measured = (
      time: number,
      requests: number,
      wait_ms: number,
      wait_count: number,
      process_ms: number,
      process_count: number,
    ) => add(first, time, 'requests', { requests, wait_ms, wait_count, process_ms, process_count });
    measured(Date.UTC(2025, 11, 28, 23, 59), 99, 10, 1, 10, 1);
    measured(Date.UTC(2025, 11, 29), 1, 20, 1, 80, 1);
    measured(Date.UTC(2025, 11, 31, 23, 59), 1, 80, 1, 100, 1);
    measured(at(1), 2, 70, 2, 30, 1);
    measured(at(2, 0, 10), 2, 20, 2, 140, 2);
    add(first, at(2, 0, 10), 'main', {
      steps: 2,
      attempts: 2,
      tools: 1,
      input_tokens: 60,
      output_tokens: 10,
    });
    add(first, at(2, 0, 10), 'subagent', {
      steps: 2,
      attempts: 3,
      errors: 1,
      tools: 1,
      branches_started: 1,
      branches_finished: 1,
      input_tokens: 25,
      output_tokens: 5,
      unknown_output: 1,
    });
    add(first, at(2, 0, 10), 'initiative_main', {
      delivered: 1,
      input_tokens: 8,
      output_tokens: 2,
    });
    add(first, at(2, 0, 10), 'summary', { input_tokens: 10 });
    add(first, at(2, 0, 10), 'profile_update', { input_tokens: 7, output_tokens: 3 });
    const laterStart = at(2, 1, 15);
    clock.mockReturnValue(laterStart);
    const second = scopeFor(storage, 'vk:two');
    const empty = scopeFor(storage, 'vk:empty');
    for (const scope of [second, empty])
      await storage.chats.create(scope, {
        enabled: true,
        responseMode: 'normal',
        createdAt: laterStart,
      });
    add(second, at(2, 1, 30), 'requests', { requests: 4 });
    measured(at(2, 2), 1, 40, 1, 20, 1);
    clock.mockReturnValue(through);
    const report = createChatRequestMetrics({
      authorization,
      reader: chatRequestMetricsStore(storage),
    });
    const context = (scope: ConnectionScope) =>
      authorization.context({ scope, userId: ownerId, kind: 'owner' });
    async function read(scope: ConnectionScope, period: ChatMetricsPeriod) {
      const result = await report.read(context(scope), period);
      expect(result.allowed).toBe(true);
      if (!result.allowed) throw Error('Отказ владельцу в чтении метрик');
      return result.value;
    }
    const today = await read(first, 'today');
    expect(today).toMatchObject({ granularity: 'hour', from: at(2), through, startedAt: began });
    expect(today.points.map(({ at, values }) => [at, values?.requests])).toEqual([
      [at(2), 2n],
      [at(2) + hour, 0n],
      [at(2) + 2 * hour, 1n],
    ]);
    expect(today.total).toMatchObject({
      requests: 3n,
      waiting: { count: 3n, totalMs: 60n, averageMs: 20 },
      processing: { count: 3n, totalMs: 160n, averageMs: 160 / 3 },
      main: {
        label: 'Основная модель',
        steps: 2n,
        attempts: 2n,
        tools: 1n,
        tokens: { input: 68n, output: 12n, incomplete: false },
      },
      subagents: {
        label: 'Субагенты',
        steps: 2n,
        attempts: 3n,
        errors: 1n,
        tools: 1n,
        started: 1n,
        finished: 1n,
        tokens: { input: 25n, output: 5n, unknownOutput: 1n, incomplete: true },
      },
      tokens: { total: 130n, incomplete: true },
      initiative: { delivered: 1n, tokens: { total: 10n } },
      background: {
        tokens: { total: 20n },
        summary: { total: 10n },
        profileUpdate: { total: 10n },
      },
    });
    const week = await read(first, 'week');
    expect(week).toMatchObject({ granularity: 'day', from: Date.UTC(2025, 11, 29) });
    expect(week.points.map(({ values }) => values?.requests)).toEqual([1n, 0n, 1n, 2n, 3n]);
    expect(week.total).toMatchObject({
      waiting: { count: 7n, averageMs: 230 / 7 },
      processing: { count: 6n, averageMs: 370 / 6 },
    });
    const month = await read(first, 'month');
    expect(month).toMatchObject({ granularity: 'day', from: at(1) });
    expect(month.points.map(({ values }) => values?.requests)).toEqual([2n, 3n]);
    expect(month.total).toMatchObject({
      waiting: { count: 5n, averageMs: 26 },
      processing: { count: 4n, averageMs: 47.5 },
    });
    const year = await read(first, 'year');
    expect(year).toMatchObject({ granularity: 'month', from: at(1) });
    expect(year.points).toEqual([{ at: at(1), values: month.total }]);
    expect(year.total).toEqual(month.total);
    expect(await read(first, 'year')).toEqual(year);

    for (const period of ['today', 'week', 'month', 'year'] as const) {
      const other = await read(second, period);
      expect(other.startedAt).toBe(laterStart);
      expect(other.total).toMatchObject({
        requests: 4n,
        waiting: { averageMs: null },
        tokens: { total: 0n },
      });
    }
    const noEvents = await read(empty, 'today');
    expect(noEvents.points.map(({ values }) => values?.requests ?? null)).toEqual([null, 0n, 0n]);
    clock.mockReturnValue(at(2, 1));
    expect((await read(empty, 'today')).total).toBeNull();
  } finally {
    authorization.dispose();
    await storage.close();
    clock.mockRestore();
  }
});

test('только владелец читает агрегаты выбранного поколения, включая проверку после авторизации', async () => {
  const storage = await openStorage(':memory:');
  const life = lifecycleBackend(storage);
  const scope = scopeFor(storage, 'vk:selected');
  await storage.chats.create(scope, {
    enabled: true,
    responseMode: 'normal',
    createdAt: Date.now(),
  });
  await storage.authorization.transaction(scope, (tx) =>
    tx.grant({ userId: 'vk:admin', basis: 'explicit', grantedBy: ownerId, grantedAt: Date.now() }),
  );
  const authorization = await createAuthorizationService({
    config: settings,
    store: storage.authorization,
  });
  try {
    const reader = { read: vi.fn(chatRequestMetricsStore(storage).read) };
    const service = createChatRequestMetrics({ authorization, reader });
    for (const userId of ['vk:member', 'vk:admin'] as const) {
      expect((await service.read(authorization.context({ scope, userId }), 'today')).allowed).toBe(
        false,
      );
    }
    expect(reader.read).not.toHaveBeenCalled();
    const owner = authorization.context({ scope, userId: ownerId, kind: 'owner' });
    expect((await service.read(owner, 'today')).allowed).toBe(true);
    const racing = createChatRequestMetrics({
      authorization: {
        async check(context, action) {
          const permitted = await authorization.check(context, action);
          if (permitted.allowed) life.ownerDecision(life.begin(scope.chatId), 'new');
          return permitted;
        },
      },
      reader,
    });
    expect(await racing.read(owner, 'today')).toEqual({ allowed: false, code: 'conflict' });
    expect((await service.read(owner, 'month')).allowed).toBe(false);
  } finally {
    authorization.dispose();
    await storage.close();
  }
});
