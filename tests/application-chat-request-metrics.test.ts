import { expect, test, vi } from 'vitest';
import type { ConnectionScope } from '../src/contracts/index';
import type { MetricsSeries } from '../src/contracts/chat-metrics';
import { createAgentLoopQueue, createChatQueue, createPublicationService } from '../src/core/index';
import { createAttemptSummary } from '../src/core/agent-loop/summary';
import { queueConfig } from '../src/core/chat-queue/validation';
import {
  beginMeasuredPublication,
  chatRequestMetricsStore,
  confirmMeasuredPart,
} from '../src/storage/chat-request-metrics-store';
import { openStorage } from '../src/storage/index';
import { queueBackend } from '../src/storage/queue-registry';
import { lifecycleBackend } from '../src/storage/lifecycle-store';
import type { Storage } from '../src/storage/types';
import type { LlmRequest, LlmResult, LlmToolCall } from '../src/llm/types';
import { tokenBudgetStore } from '../src/storage/token-budget-store';
import { answer, fixture, mention, peer, until } from './helpers/application-response-fixture';
import { flushQueue, queueMessage } from './helpers/chat-queue';
import { scopeFor } from './helpers/connection-scope';
import { storageFixture } from './helpers/storage-fixture';

function totals(storage: Storage, scope: ConnectionScope, series: MetricsSeries) {
  return chatRequestMetricsStore(storage)
    .read(scope, 'day', 0, Date.now())
    .buckets.find((row) => row.series === series)?.totals;
}
const requests = (storage: Storage, scope: ConnectionScope) => totals(storage, scope, 'requests');

const tools = (input: number | null, output: number | null, ...calls: LlmToolCall[]) =>
  ({
    kind: 'tool_calls',
    text: null,
    calls,
    usage: { input, output },
  }) as const;
const delegate = (id: string, readers: string[] = []) => ({
  id,
  name: 'delegate',
  arguments: JSON.stringify({ goal: 'Закрытая цель', sources: ['current'], tools: readers }),
});
const read = { id: 'закрытый-id', name: 'history_search', arguments: '{"query":"Маяк","limit":1}' };
const helperAnswer = {
  ...answer,
  text: '{"answer":"Результат","citations":["current"],"gaps":[]}',
  usage: { input: 15, output: 5 },
};

test(
  'чтение и повтор субагента дают отдельные шаги, попытки и инструменты',
  { timeout: 10_000 },
  async () => {
    const app = await fixture({ summaryIntervalMs: 25, summaryFragmentSize: 1 });
    try {
      tokenBudgetStore(app.storage).update(app.scope, true, { total: 100_000 }, app.start);
      const foreground: LlmResult[] = [
        tools(30, 5, delegate('закрытое-поручение', ['history_search'])),
        tools(10, 0, read),
        { kind: 'error', code: 'server', message: 'Сбой провайдера' },
        helperAnswer,
        { ...answer, usage: { input: 30, output: 5 } },
      ];
      let foregroundCalls = 0,
        summaryCalls = 0;
      app.complete.mockImplementation(async (request) => {
        if (request.system.startsWith('Кратко перескажи'))
          return { ...answer, usage: { input: summaryCalls++ === 0 ? 10 : 0, output: 0 } };
        return foreground[foregroundCalls++]!;
      });
      const input = app.submit(mention);
      await app.trace(input, 5_000);
      expect(foregroundCalls).toBe(5);
      expect(requests(app.storage, app.scope)?.requests).toBe(1n);
      expect(totals(app.storage, app.scope, 'main')).toMatchObject({
        steps: 2n,
        attempts: 2n,
        errors: 0n,
        tools: 1n,
        input_tokens: 60n,
        output_tokens: 10n,
        unknown_input: 0n,
        unknown_output: 0n,
      });
      expect(totals(app.storage, app.scope, 'subagent')).toMatchObject({
        steps: 2n,
        attempts: 3n,
        errors: 1n,
        tools: 1n,
        branches_started: 1n,
        branches_finished: 1n,
        input_tokens: 25n,
        output_tokens: 5n,
        unknown_input: 1n,
        unknown_output: 1n,
      });
      expect(
        JSON.stringify(app.db.prepare('SELECT * FROM chat_metrics_attempts').all()),
      ).not.toMatch(/закрыт|Маяк|Сбой|Результат/u);
      await app.storage.messages.append(app.scope, {
        chatId: app.scope.chatId,
        messageId: 'old-summary',
        userId: 'vk:42',
        authorName: 'Ира',
        role: 'user',
        text: 'Вчера встретились у маяка.',
        timestamp: app.start - 86_400_000,
      });
      await until(() =>
        expect(totals(app.storage, app.scope, 'summary')).toMatchObject({
          attempts: BigInt(summaryCalls),
          input_tokens: 10n,
          output_tokens: 0n,
          unknown_input: 0n,
          unknown_output: 0n,
        }),
      );
      const calculated = chatRequestMetricsStore(app.storage)
        .read(app.scope, 'day', 0, Date.now())
        .buckets.reduce((sum, row) => sum + row.totals.input_tokens + row.totals.output_tokens, 0n);
      expect(calculated).toBe(110n);
      expect(tokenBudgetStore(app.storage).read(app.scope, true, Date.now()).total.confirmed).toBe(
        calculated,
      );
    } finally {
      await app.close();
    }
  },
);

test('повтор поручения использует готовый результат, параллельные субагенты имеют разные шаги', async () => {
  const first = Promise.withResolvers<LlmResult>();
  const second = Promise.withResolvers<LlmResult>();
  const main = vi
    .fn<(request: LlmRequest) => Promise<LlmResult>>()
    .mockResolvedValueOnce(tools(1, 1, delegate('first'), delegate('second')))
    .mockResolvedValueOnce(tools(1, 1, delegate('first')))
    .mockResolvedValueOnce(answer);
  const assistant = vi
    .fn<(request: LlmRequest) => Promise<LlmResult>>()
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  const app = await fixture({
    modelClients: { client: { complete: main }, auxiliaryClient: { complete: assistant } },
  });
  try {
    tokenBudgetStore(app.storage).update(app.scope, true, { total: 100_000 }, app.start);
    const input = app.submit(mention);
    await vi.waitFor(() => expect(assistant).toHaveBeenCalledTimes(2), {
      timeout: 2_500,
      interval: 5,
    });
    expect(totals(app.storage, app.scope, 'subagent')).toMatchObject({
      steps: 2n,
      branches_started: 2n,
      branches_finished: 0n,
    });
    second.resolve(helperAnswer);
    first.resolve(helperAnswer);
    await app.published(input);
    expect(main).toHaveBeenCalledTimes(3);
    expect(assistant).toHaveBeenCalledTimes(2);
    expect(totals(app.storage, app.scope, 'main')).toMatchObject({
      steps: 3n,
      attempts: 3n,
      tools: 2n,
    });
    expect(totals(app.storage, app.scope, 'subagent')).toMatchObject({
      steps: 2n,
      attempts: 2n,
      branches_finished: 2n,
    });
  } finally {
    first.resolve(helperAnswer);
    second.resolve(helperAnswer);
    await app.close();
  }
});

test('отказ перед отправкой во время паузы F9.1 сохраняет обращение без работы модели', async () => {
  const app = await fixture();
  try {
    const neighbor = await app.connectGroup(peer + 1);
    app.complete.mockResolvedValueOnce({ kind: 'error', code: 'rate_limit', message: 'Сбой' });
    const first = app.submit(mention);
    expect((await app.trace(first)).payload.resultKind).toBe('rate_limit');
    const paused = app.submit(mention, 41, undefined, peer + 1);
    expect((await app.trace(paused, 1_800, peer + 1)).payload.resultKind).toBe(
      'llm_provider_paused',
    );
    expect(totals(app.storage, app.scope, 'main')).toMatchObject({
      steps: 1n,
      attempts: 1n,
      errors: 1n,
    });
    expect(requests(app.storage, neighbor)?.requests).toBe(1n);
    expect(totals(app.storage, neighbor, 'main')).toBeUndefined();
    expect(app.complete).toHaveBeenCalledOnce();
  } finally {
    await app.close();
  }
});

test(
  'из ста сообщений учитываются три обращения, дубль и отказ по квоте разделены по беседам',
  { timeout: 20_000 },
  async () => {
    const app = await fixture({ userRequests: 1 });
    try {
      const neighbor = await app.connectGroup(peer + 1);
      app.at(1_000);
      const messages = app.db
        .prepare("SELECT count(*) FROM messages WHERE chat_id=? AND role='user'")
        .pluck();
      for (let i = 0; i < 97; i++) app.submit(`Реплика ${i}`);
      await vi.waitFor(() => expect(messages.get(app.scope.chatId)).toBe(97), {
        interval: 10,
        timeout: 12_000,
      });
      const first = app.submit(mention);
      await app.published(first);
      app.replay(first);
      const denied = app.submit(mention);
      expect((await app.trace(denied)).payload.resultKind).toBe('quota_exhausted');
      app.complete.mockResolvedValueOnce({
        kind: 'error',
        code: 'authentication',
        message: 'Сбой',
      });
      const failed = app.submit(mention, 42);
      expect((await app.trace(failed)).payload.resultKind).toBe('error');
      await app.published(app.submit(mention, 41, undefined, peer + 1));
      expect(requests(app.storage, app.scope)).toMatchObject({
        requests: 3n,
        quota_denied: 1n,
        wait_count: 3n,
        process_count: 3n,
      });
      expect(requests(app.storage, neighbor)).toMatchObject({
        requests: 1n,
        quota_denied: 0n,
        wait_count: 1n,
        process_count: 1n,
      });
      expect(app.complete).toHaveBeenCalledTimes(3);
      expect(
        app.db
          .prepare("SELECT count(*) FROM messages WHERE chat_id=? AND role='user'")
          .pluck()
          .get(app.scope.chatId),
      ).toBe(100);
    } finally {
      await app.close();
    }
  },
);

const route = () =>
  ({ reason: 'mention', route: { kind: 'mention', mode: 'normal', isGroupChat: true } }) as const;
const day = Date.UTC(2026, 10, 24);

test('известная часть остаётся в метриках при приостановке и продолжении подключения', async () => {
  const storage = await openStorage(':memory:');
  const scope = scopeFor(storage, 'vk:chat');
  const life = lifecycleBackend(storage);
  const finished = Promise.withResolvers<void>();
  await storage.chats.create(scope, {
    enabled: true,
    responseMode: 'normal',
    createdAt: Date.now(),
  });
  const publication = createPublicationService({
    storage,
    port: {
      async canReply() {
        return true;
      },
      async publish(input) {
        if (!input.beforeSend?.()) return { kind: 'failed' };
        input.confirmPart({
          messageId: 'out:1',
          userId: 'vk:bot',
          authorName: '',
          text: 'Первая часть',
          timestamp: Date.now(),
          replyToMessageId: '1',
        });
        life.applyConnectionSignal(life.begin(scope.chatId), 'pause-after-part');
        return { kind: 'unknown', confirmedParts: 1 };
      },
    },
  });
  const queue = createChatQueue({
    storage,
    tracing: { messageRetentionDays: 30 },
    async handler() {
      return {
        outcome: 'completed',
        result: {
          kind: 'complete',
          text: 'Ответ из двух частей',
          summary: createAttemptSummary().snapshot(0),
        },
      };
    },
    async onSettled(work, completion) {
      try {
        await publication.onSettled(work, completion);
      } finally {
        finished.resolve();
      }
    },
  });
  try {
    await queue.start();
    await queue.admitRouted(scope, queueMessage(scope.chatId, '1'), route);
    await finished.promise;
    const active = life.ownerDecision(life.begin(scope.chatId), 'continue');
    expect(active.generation).toBe(scope.generation);
    expect(requests(storage, active)).toMatchObject({
      requests: 1n,
      partial: 1n,
      delivered: 0n,
      unknown_delivery: 0n,
    });
  } finally {
    await queue.stop();
    await storage.close();
  }
});

test('полная, частичная и неизвестная доставка различаются после удаления трассировок и перезапуска', async () => {
  const app = await fixture();
  const text = '🙂'.repeat(1100);
  try {
    tokenBudgetStore(app.storage).update(app.scope, true, { total: 100_000 }, app.start);
    app.complete.mockResolvedValue({ ...answer, text });
    const all = await app.trace(app.submit(mention));
    expect(all.payload.publication.status).toBe('delivered');
    expect(app.sends).toHaveLength(2);
    app.failSend((part) => (Buffer.byteLength(part) < 4_000 ? 901 : undefined));
    const part = await app.trace(app.submit(mention));
    expect(part.payload.publication.reason).toBe('partial_delivery');
    expect(app.sends).toHaveLength(3);
    app.failSend(() => 'unknownAfterDelivery');
    const unknown = await app.trace(app.submit(mention));
    expect(unknown.payload.publication.status).toBe('unknown');
    expect(requests(app.storage, app.scope)).toMatchObject({
      requests: 3n,
      delivered: 1n,
      partial: 1n,
      unknown_delivery: 1n,
    });
    app.db.prepare('DELETE FROM response_traces').run();
    await app.restart(true);
    expect(requests(app.storage, app.scope)).toMatchObject({
      requests: 3n,
      delivered: 1n,
      partial: 1n,
      unknown_delivery: 1n,
    });
  } finally {
    await app.close();
  }
});

test('очередь восстанавливает остановку между частями и учитывает подтверждённый последний фрагмент', async () => {
  const files = storageFixture();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(day);
  let storage = await openStorage(files.path);
  try {
    const scope = scopeFor(storage, 'vk:chat');
    await storage.chats.create(scope, { enabled: true, responseMode: 'normal', createdAt: day });
    const backend = queueBackend(storage);
    backend.acquire('old', 30_000, 1);
    for (let n = 0; n < 3; n++) {
      backend.admitRouted(
        'old',
        scope,
        queueMessage(scope.chatId, String(n)),
        route,
        queueConfig(),
      );
      const work = backend.take('old')!;
      expect(backend.finish('old', work, 'completed')).toBe('completed');
      lifecycleBackend(storage).transaction(scope, (db) => {
        beginMeasuredPublication(db, scope, work.id);
        if (n !== 0) {
          confirmMeasuredPart(db, scope, work.id, false);
          confirmMeasuredPart(db, scope, work.id, n === 2);
        }
      });
    }
    expect(requests(storage, scope)).toMatchObject({
      delivered: 1n,
      partial: 0n,
      unknown_delivery: 0n,
    });
    backend.release('old');
    await storage.close();
    storage = await openStorage(files.path);
    const restored = scopeFor(storage, scope.chatId);
    const current = queueBackend(storage);
    for (const owner of ['new', 'next']) {
      current.acquire(owner, 30_000, 1);
      expect(requests(storage, restored)).toMatchObject({
        delivered: 1n,
        partial: 1n,
        unknown_delivery: 1n,
      });
      current.release(owner);
    }
  } finally {
    await storage.close();
    files.cleanup();
    clock.mockRestore();
  }
});

test(
  'два фоновых источника и реплика из двух частей дают отдельные значения при одном обращении',
  { timeout: 12_000 },
  async () => {
    const app = await fixture({
      active: true,
      summaryIntervalMs: 25,
      summaryFragmentSize: 1,
      profileNotice: 'В беседе действует выбор использования профиля.',
      greetings: { members: [41, 42, 73] },
    });
    let summaries = 0;
    try {
      tokenBudgetStore(app.storage).update(app.scope, true, { total: 100_000 }, app.start);
      app.complete.mockImplementation(async (request) => {
        if (request.system.startsWith('Extract stable facts'))
          return { ...answer, text: '[]', usage: { input: 7, output: 3 } };
        if (request.system.startsWith('Кратко перескажи'))
          return { ...answer, usage: { input: summaries++ === 0 ? 10 : 0, output: 0 } };
        return { ...answer, usage: { input: 60, output: 10 } };
      });
      app.at(1_000);
      expect((await app.trace(app.submit(mention))).payload.publication.status).toBe('delivered');
      app.complete.mockResolvedValueOnce({
        ...answer,
        text: '🙂'.repeat(1100),
        usage: { input: 6, output: 4 },
      });
      app.at(2_000);
      const replied = await app.trace(app.submit('Кто-нибудь, помогите разобраться с расписанием'));
      expect(replied.payload.route?.kind).toBe('initiative');
      expect(replied.payload.publication.status).toBe('delivered');
      expect(app.sends.filter(({ text }) => text.includes('🙂'))).toHaveLength(2);
      for (let i = 0; i < 10; i++) await app.journaled(app.submit(`Обычная реплика ${i}`));
      await app.storage.messages.append(app.scope, {
        chatId: app.scope.chatId,
        messageId: 'yesterday',
        role: 'user',
        userId: 'vk:42',
        authorName: 'Ира',
        text: 'Встречаемся у дуба.',
        timestamp: app.start - 86_400_000,
      });
      await until(() => {
        expect(totals(app.storage, app.scope, 'profile_update')).toMatchObject({
          input_tokens: 7n,
          output_tokens: 3n,
        });
        expect(totals(app.storage, app.scope, 'summary')).toMatchObject({
          input_tokens: 10n,
          output_tokens: 0n,
        });
      });
      expect(requests(app.storage, app.scope)).toMatchObject({ requests: 1n, delivered: 1n });
      expect(totals(app.storage, app.scope, 'initiative_main')).toMatchObject({
        delivered: 1n,
        input_tokens: 6n,
        output_tokens: 4n,
      });
      const spent = chatRequestMetricsStore(app.storage)
        .read(app.scope, 'day', 0, Date.now())
        .buckets.reduce((sum, row) => sum + row.totals.input_tokens + row.totals.output_tokens, 0n);
      expect(spent).toBe(100n);
    } finally {
      await app.close();
    }
  },
);

test('переполнение сохраняет обращение, у истечения в очереди есть только замер ожидания', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(day);
  const storage = await openStorage(':memory:');
  const scope = scopeFor(storage, 'vk:chat');
  await storage.chats.create(scope, { enabled: true, responseMode: 'normal', createdAt: day });
  const first = Promise.withResolvers<'completed'>();
  const queue = createChatQueue({
    storage,
    tracing: { messageRetentionDays: 30 },
    config: { maxQueuedPerChat: 1, maxQueueAgeMs: 1_000 },
    handler: () => first.promise,
  });
  const submit = (n: number) =>
    queue.admitRouted(scope, queueMessage(scope.chatId, String(n)), route);
  try {
    await queue.start();
    expect((await submit(1)).admission.status).toBe('queued');
    await flushQueue();
    await vi.advanceTimersByTimeAsync(100);
    expect((await submit(2)).admission.status).toBe('queued');
    expect((await submit(3)).admission.status).toBe('queue_full');
    await vi.advanceTimersByTimeAsync(1_900);
    first.resolve('completed');
    await flushQueue();
    expect(requests(storage, scope)).toMatchObject({
      requests: 3n,
      queue_full: 1n,
      expired: 1n,
      wait_count: 2n,
      wait_ms: 1_000n,
      process_count: 1n,
      process_ms: 2_000n,
    });
  } finally {
    first.resolve('completed');
    await queue.stop();
    await storage.close();
    vi.useRealTimers();
  }
});

test('восстановление очереди завершает работу без замера времени обработки', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(day);
  const storage = await openStorage(':memory:');
  try {
    const scope = scopeFor(storage, 'vk:chat');
    await storage.chats.create(scope, { enabled: true, responseMode: 'normal', createdAt: day });
    const queue = queueBackend(storage);
    queue.acquire('old', 1000, 1);
    queue.admitRouted('old', scope, queueMessage(scope.chatId, '1'), route, queueConfig());
    clock.mockReturnValue(day + 60);
    expect(queue.take('old')?.id).toBeDefined();
    clock.mockReturnValue(day + 1000);
    expect(queue.acquire('new', 1000, 1)).toBe(1);
    queue.release('new');
    expect(queue.acquire('next', 1000, 1)).toBe(0);
    expect(requests(storage, scope)).toMatchObject({
      requests: 1n,
      wait_count: 1n,
      wait_ms: 60n,
      interrupted: 1n,
      process_count: 0n,
    });
  } finally {
    await storage.close();
    clock.mockRestore();
  }
});

test.each(['до очистки F4.6', 'после очистки F4.6'] as const)(
  'позднее уточнение %s меняет только день отправки и учитывается один раз',
  async (mode) => {
    const files = storageFixture();
    const received = day + 86_340_000;
    const sent = day + 86_460_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(received);
    let storage = await openStorage(files.path);
    const scope = scopeFor(storage, 'vk:metrics');
    await storage.chats.create(scope, {
      enabled: true,
      responseMode: 'normal',
      createdAt: received,
    });
    const preparation = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const publication = createPublicationService({
      storage,
      port: {
        async canReply() {
          return true;
        },
        async publish(input) {
          if (!input.beforeSend?.()) return { kind: 'failed' };
          return {
            kind: 'delivered',
            receipt: { messageId: 'out', userId: 'vk:bot', authorName: '', timestamp: Date.now() },
          };
        },
      },
    });
    const queue = createAgentLoopQueue({
      storage,
      tokenBudget: true,
      config: { leaseMs: 180_000 },
      tracing: { messageRetentionDays: 30 },
      modelName: 'synthetic',
      onSettled: publication.onSettled,
      client: {
        async complete() {
          return { ...answer, usage: { input: 0, output: null } };
        },
      },
      async prepare() {
        entered.resolve();
        await preparation.promise;
        return {
          kind: 'ready',
          input: {
            system: '',
            messages: [{ role: 'user', text: 'Вход' }],
            maxOutputTokens: 2,
            sessionId: 'test',
          },
        };
      },
    });
    try {
      await queue.start();
      const { admission } = await queue.admitRouted(scope, queueMessage(scope.chatId, '1'), route);
      expect(admission.status).toBe('queued');
      await entered.promise;
      clock.mockReturnValue(sent);
      preparation.resolve();
      await until(async () =>
        expect(await storage.queue.get(scope, 1)).toMatchObject({ outcome: 'completed' }),
      );
      await until(() => expect(requests(storage, scope)?.delivered).toBe(1n));
      await queue.stop();
      const intent = lifecycleBackend(storage).transaction(scope, (db) =>
        db
          .prepare(
            'SELECT attempt_key AS key,admitted_at AS at FROM token_budget_attempts WHERE chat_id=?',
          )
          .get(scope.chatId),
      ) as { key: string; at: number };
      expect(intent.at).toBe(sent);
      let metrics = chatRequestMetricsStore(storage);
      expect(
        metrics.read(scope, 'day', 0, sent).buckets.map((row) => [row.at, row.series]),
      ).toEqual([
        [day, 'requests'],
        [day + 86_400_000, 'main'],
      ]);
      expect(totals(storage, scope, 'main')).toMatchObject({
        attempts: 1n,
        input_tokens: 0n,
        unknown_input: 0n,
        unknown_output: 1n,
      });
      const later = day + 172_800_000 + (mode === 'после очистки F4.6' ? 120_000 : 0);
      clock.mockReturnValue(later);
      const backend = queueBackend(storage);
      backend.acquire('maintenance', 30_000, 1);
      expect(backend.pruneTokenBudget('maintenance')).toBe(mode === 'после очистки F4.6' ? 1 : 0);
      backend.pruneMetrics('maintenance');
      backend.release('maintenance');
      lifecycleBackend(storage).transaction(scope, (db) =>
        db.prepare('DELETE FROM response_traces').run(),
      );
      await storage.close();
      storage = await openStorage(files.path);
      const restored = scopeFor(storage, scope.chatId);
      metrics = chatRequestMetricsStore(storage);
      const budget = tokenBudgetStore(storage);
      for (let retry = 0; retry < 2; retry++)
        expect(budget.reconcile(restored, intent.key, { input: 7, output: 9 })).toBe(true);
      const snapshots = metrics.read(restored, 'day', 0, later).buckets;
      expect(snapshots.map((row) => [row.at, row.series])).toEqual([
        [day, 'requests'],
        [day + 86_400_000, 'main'],
      ]);
      expect(snapshots[1]?.totals).toMatchObject({
        input_tokens: 0n,
        output_tokens: 9n,
        unknown_input: 0n,
        unknown_output: 0n,
      });
      expect(snapshots[0]?.totals).toMatchObject({ requests: 1n, delivered: 1n });
      expect(metrics.read(restored, 'hour', 0, later).buckets).toEqual([]);
      expect(budget.read(restored, true, sent).total.confirmed).toBe(
        mode === 'после очистки F4.6' ? 0n : 9n,
      );
    } finally {
      preparation.resolve();
      await queue.stop();
      await storage.close();
      files.cleanup();
      clock.mockRestore();
    }
  },
);
