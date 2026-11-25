import { performance } from 'node:perf_hooks';
import { expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { openStorage } from '../../src/storage/index';
import { scopeFor } from '../helpers/connection-scope';
import { storageFixture } from '../helpers/storage-fixture';
import { catalogAdministration, installStarterPersonas } from '../../src/storage/catalog-admin';
import { contextCapabilities, contextFixture } from '../helpers/context';
import { createContextBuilder } from '../../src/core/context/index';
import { recordQueueLoad, summarizeDurations } from '../helpers/queue-load-fixture';

const nowMs = Date.parse('2026-11-23T00:00:00Z');

test.each([false, true])('замер подготовки истории, беседа=%s', async (isGroupChat) => {
  const warmupRuns = 5;
  const measuredRuns = 30;
  const modelContextTokens = 64000;
  for (const historySize of [5, 50, 100]) {
    const fixture = await contextFixture();
    try {
      const historyIds: number[] = [];
      for (let index = 0; index < historySize; index++) {
        const row = await fixture.put(`history-${index}`, 'Короткая предыдущая реплика.');
        historyIds.push(row.id);
      }
      const trigger = await fixture.put('trigger', 'Что было раньше?');
      const work = fixture.work(trigger.id, isGroupChat);
      for (const limited of [false, true]) {
        const inputBudgetTokens = limited ? (isGroupChat ? 1788 : 1992) : 32000;
        const selectedHistory = limited ? 3 : historySize;
        const builder = createContextBuilder({
          ...fixture.options,
          config: { modelContextTokens, inputBudgetTokens },
          now: () => nowMs,
        });
        const expected = await builder.prepare(work);
        if (expected.kind !== 'ready') throw Error(`Исход подготовки: ${expected.kind}`);
        expect(expected.metadata.messageIds).toEqual([
          ...historyIds.slice(-selectedHistory),
          trigger.id,
        ]);
        const snapshot = JSON.stringify(expected);
        for (let series = 1; series <= 3; series++) {
          globalThis.gc?.();
          const samplesMs: number[] = [];
          for (let run = 0; run < warmupRuns + measuredRuns; run++) {
            const start = performance.now();
            const result = await builder.prepare(work);
            const elapsedMs = performance.now() - start;
            if (result.kind !== 'ready') throw Error(`Исход подготовки: ${result.kind}`);
            expect(JSON.stringify(result)).toBe(snapshot);
            if (run >= warmupRuns) samplesMs.push(elapsedMs);
            // На исходной версии это ограничивает накопление экземпляров Intl между вызовами.
            globalThis.gc?.();
          }
          await recordQueueLoad({
            benchmark: 'contextPreparation',
            revision: process.env.AWESOME_CONTEXT_BENCHMARK_REVISION ?? 'working-tree',
            node: process.version,
            nowMs,
            isGroupChat,
            historySize,
            selectedHistory,
            inputBudgetTokens,
            modelContextTokens,
            gcOutsideMeasurement: !!globalThis.gc,
            series,
            warmupRuns,
            measuredRuns,
            ...summarizeDurations(samplesMs),
          });
        }
      }
    } finally {
      await fixture.storage.close();
    }
  }
});

test('50000 записей: индекс, ограниченные SQL-проекции и срок подготовки', async () => {
  const f = storageFixture(),
    s = await openStorage(f.path),
    scope = scopeFor(s, 'vk:loadctx'),
    db = new Database(f.path);
  try {
    await s.chats.create(scope, { enabled: true, responseMode: 'normal', createdAt: 0 });
    installStarterPersonas(s, 0);
    expect(
      await s.authorization.transaction(scope, (tx) =>
        tx.selectStarterPersona('vk:u', 'chipsik', {
          sourceChatId: scope.chatId,
          messageId: 1,
          timestamp: 0,
        }),
      ),
    ).toEqual({ status: 'selected' });
    const admin = catalogAdministration(s);
    const v = await admin.append({
      kind: 'system_prompt',
      key: 'k',
      text: 'Правила',
      createdAt: 0,
      expectedHead: null,
    });
    if (v.status !== 'created' || v.value.ref.area !== 'global') throw Error();
    await admin.selectSystemPrompt(v.value.ref, null);
    db.transaction(() => {
      const ins = db.prepare(
        "INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp,purpose) VALUES('vk:loadctx',?,'vk:u','Имя','user',?,0,?)",
      );
      for (let i = 0; i < 50000; i++)
        ins.run(String(i), 'история '.repeat(50), i % 2 ? 'conversation' : 'service_notice');
    })();
    const trigger = await s.messages.append(scope, {
      chatId: scope.chatId,
      messageId: 'trigger',
      userId: 'vk:u',
      authorName: '',
      role: 'user',
      text: 'Вопрос',
      timestamp: 100,
    });
    db.prepare(
      "INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp) VALUES('vk:loadctx','late','vk:u','','user',?,0)",
    ).run('ПОЗДНО'.repeat(100000));
    let pages = 0,
      rows = 0,
      bytes = 0;
    const messages = {
      ...s.contextMessages,
      async page(...args: Parameters<typeof s.contextMessages.page>) {
        pages++;
        const values = await s.contextMessages.page(...args);
        rows += values.length;
        bytes += values.reduce(
          (n, m) => n + Buffer.byteLength(m.text) + Buffer.byteLength(m.authorName),
          0,
        );
        return values;
      },
    };
    const builder = createContextBuilder({
      messages,
      state: s.contextState,
      config: { modelContextTokens: 16000 },
      capabilities: async () => contextCapabilities(scope.chatId),
      sessionId: () => 'opaque',
      now: () => nowMs,
    });
    const start = performance.now();
    const result = await builder.prepare({
      scope,
      messageId: trigger.id,
      route: { kind: 'mention', mode: 'normal', isGroupChat: true },
      signal: new AbortController().signal,
      isCurrent: () => true,
    });
    const elapsed = performance.now() - start;
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;
    expect(elapsed).toBeLessThan(builder.config.preparationTimeoutMs);
    expect(rows).toBeLessThanOrEqual(256);
    expect(pages).toBeLessThanOrEqual(8);
    expect(bytes).toBeLessThanOrEqual(rows * 2 * 2048 * 4);
    expect(JSON.stringify(result.input)).not.toContain('ПОЗДНО');
    expect(result.metadata.persona?.version).toMatchObject({ key: 'chipsik', version: 1 });
    expect(result.metadata.estimatedTokens).toBeLessThanOrEqual(builder.config.inputBudgetTokens);
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM messages WHERE chat_id='vk:loadctx' AND purpose='conversation' AND id<=? AND id<? ORDER BY id DESC LIMIT 32",
      )
      .all(trigger.id, trigger.id);
    expect(JSON.stringify(plan)).toContain('messages_context_order');
    await recordQueueLoad({
      context: true,
      records: 50000,
      elapsedMs: elapsed,
      pages,
      rows,
      projectedBytes: bytes,
      personaBytes: result.metadata.persona!.bytes,
    });
  } finally {
    db.close();
    await s.close();
    f.cleanup();
  }
});
