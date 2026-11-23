import Database from 'better-sqlite3';
import { expect, test, vi } from 'vitest';
import { createAgentLoopQueue } from '../src/core/index';
import { createContextPreparation } from '../src/core/prepare-context';
import type { LlmClient, LlmResult } from '../src/llm/types';
import { catalogAdministration } from '../src/storage/catalog-admin';
import { openStorage } from '../src/storage/index';
import { scopeFor } from './helpers/connection-scope';
import { contextCapabilities } from './helpers/context';
import { storageFixture } from './helpers/storage-fixture';

const chat = 'vk:1' as const,
  day = 86_400_000,
  epoch = 1_800_000_000_000;
const route = () =>
  ({ reason: 'mention', route: { kind: 'mention', mode: 'normal', isGroupChat: true } }) as const;
const message = (messageId: string, text: string, timestamp: number) => ({
  chatId: chat,
  userId: 'vk:2' as const,
  messageId,
  authorName: '',
  role: 'user' as const,
  text,
  timestamp,
});

async function fixture(complete: LlmClient['complete'], onPrepared?: () => void) {
  const file = storageFixture();
  const db = new Database(file.path);
  const storage = await openStorage(file.path, { messageRetentionDays: 30 });
  const scope = scopeFor(storage, chat);
  await storage.chats.create(scope, { enabled: true, responseMode: 'normal', createdAt: epoch });
  const catalog = catalogAdministration(storage);
  const version = await catalog.append({
    kind: 'system_prompt',
    key: 'base',
    text: 'Синтетическая инструкция.',
    createdAt: epoch,
    expectedHead: null,
  });
  if (version.status !== 'created' || version.value.ref.area !== 'global')
    throw Error('Missing prompt');
  await catalog.selectSystemPrompt(version.value.ref, null);
  const preparation = createContextPreparation({
    storage,
    config: { modelContextTokens: 16000 },
    capabilities: async () => contextCapabilities(chat),
    sessionId: () => 'session',
  });
  const settled = vi.fn(async () => {});
  const prepare = vi.fn(async (work: Parameters<typeof preparation.prepare>[0]) => {
    const prepared = await preparation.prepare(work);
    onPrepared?.();
    return prepared;
  });
  const clock = vi.spyOn(Date, 'now').mockReturnValue(epoch);
  const queue = createAgentLoopQueue({
    storage,
    client: { complete },
    modelName: 'synthetic',
    tracing: { messageRetentionDays: 30 },
    limits: { userRequests: 1, chatRequests: 1, userWindowMs: 1000, chatWindowMs: 1000 },
    loopOptions: { retryServerErrors: true, retryDelayMs: 5 },
    prepare,
    onSettled: settled,
  });
  await queue.start();
  await storage.messages.append(scope, message('1', 'Цитата до истечения', epoch - 30 * day + 1));
  return {
    db,
    clock,
    prepare,
    settled,
    queue,
    storage,
    scope,
    async enqueue() {
      return (
        await queue.admitRouted(
          scope,
          {
            ...message('2', 'Синтетический вопрос', epoch),
            replyToMessageId: '1',
          },
          route,
        )
      ).admission;
    },
    async close() {
      try {
        await queue.stop();
      } finally {
        db.close();
        await storage.close();
        clock.mockRestore();
        file.cleanup();
      }
    },
  };
}

test('истечение источника перед допуском пересобирает контекст и списывает только первую реальную попытку', async () => {
  const complete = vi
    .fn<LlmClient['complete']>()
    .mockResolvedValue({ kind: 'complete', text: 'Ответ', usage: { input: 1, output: 1 } });
  const f = await fixture(complete, () => f.clock.mockReturnValue(epoch + 1));
  try {
    const admitted = await f.enqueue();
    expect(admitted).toMatchObject({ status: 'queued', jobId: 1 });
    await vi.waitFor(() => expect(f.settled).toHaveBeenCalledTimes(1), { interval: 5 });
    expect(f.prepare).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(complete.mock.calls[0]?.[0])).not.toContain('Цитата до истечения');
    expect(f.db.prepare('SELECT job_id FROM request_quota_admissions').all()).toEqual([
      { job_id: 1 },
    ]);
    expect((await f.storage.traces.get(f.scope, 1))?.payload.context?.messageIds).toEqual([2]);
  } finally {
    await f.close();
  }
});

test('потеря источника после допуска запрещает серверный повтор; квота сохраняется', async () => {
  const modelCalled = Promise.withResolvers<void>(),
    response = Promise.withResolvers<LlmResult>();
  const complete = vi.fn<LlmClient['complete']>(() => {
    modelCalled.resolve();
    return response.promise;
  });
  const f = await fixture(complete);
  try {
    await f.enqueue();
    await modelCalled.promise;
    f.clock.mockReturnValue(epoch + 1);
    response.resolve({ kind: 'error', code: 'server', message: 'Синтетический сбой' });
    await vi.waitFor(
      async () =>
        expect(await f.storage.queue.get(f.scope, 1)).toMatchObject({ outcome: 'interrupted' }),
      { interval: 5 },
    );
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.settled).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(f.db.prepare('SELECT job_id FROM request_quota_admissions').all()).toEqual([
      { job_id: 1 },
    ]);
  } finally {
    response.resolve({ kind: 'error', code: 'server', message: 'Синтетический сбой' });
    await f.close();
  }
});

test('очистка записи за пределами контекста сохраняет ответ; потеря исходного обращения прерывает следующий', async () => {
  const models = [Promise.withResolvers<LlmResult>(), Promise.withResolvers<LlmResult>()];
  const complete = vi
    .fn<LlmClient['complete']>()
    .mockImplementationOnce(() => models[0]!.promise)
    .mockImplementationOnce(() => models[1]!.promise);
  const f = await fixture(complete);
  try {
    await f.enqueue();
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1), { interval: 5 });
    const excluded = await f.storage.messages.append(
      f.scope,
      message('3', 'Поздняя старая запись', epoch - 30 * day),
    );
    const neighbor = scopeFor(f.storage, 'vk:2');
    await f.storage.messages.append(neighbor, {
      ...message('1', 'Соседняя беседа', epoch),
      chatId: 'vk:2',
    });
    f.queue.wakeHistoryMaintenance?.();
    await vi.waitFor(
      () =>
        expect(f.db.prepare('SELECT id FROM messages WHERE id=?').get(excluded.id)).toBeUndefined(),
      { interval: 5 },
    );
    expect(await f.storage.messages.list(neighbor, { limit: 10 })).toMatchObject([
      { text: 'Соседняя беседа' },
    ]);
    models[0]!.resolve({ kind: 'complete', text: 'Ответ', usage: { input: 1, output: 1 } });
    await vi.waitFor(() => expect(f.settled).toHaveBeenCalledTimes(1), { interval: 5 });

    f.clock.mockReturnValue(epoch + 1001);
    await f.queue.admitRouted(f.scope, message('4', 'Другое обращение', epoch + 1001), route);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2), { interval: 5 });
    const source = f.db
      .prepare("SELECT id FROM messages WHERE chat_id=? AND platform_message_id='4'")
      .get(chat) as { id: number };
    f.db.prepare('DELETE FROM messages WHERE id=?').run(source.id);
    models[1]!.resolve({ kind: 'complete', text: 'Поздний ответ', usage: { input: 1, output: 1 } });
    expect(await f.storage.queue.get(f.scope, 2)).toBeNull();
    await f.queue.stop();
    expect(f.settled).toHaveBeenCalledTimes(1);
  } finally {
    for (const model of models)
      model.resolve({ kind: 'complete', text: 'Ответ', usage: { input: 1, output: 1 } });
    await f.close();
  }
});
