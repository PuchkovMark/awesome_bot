import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { runApplication } from '../src/app/service';
import { initializePrompt, resolveApplicationChat } from '../src/app/setup';
import { createVkApi, createVkApiCall } from '../src/channels/vk/api';
import type { VkPollTransport } from '../src/channels/vk/long-poll';
import { createVkRateLimiter } from '../src/channels/vk/rate-limit';
import { loadApplicationConfig } from '../src/config/application';
import {
  createAuthorizationService,
  createAgentLoopQueue,
  createPublicationService,
  createTokenBudgetAdministration,
} from '../src/core/index';
import { responseRateConfig } from '../src/core/chat-limits/response-rate-config';
import { publicationDecision } from '../src/core/message-router/publication';
import type { LlmResult } from '../src/llm/types';
import type { SafeLogger } from '../src/logger/index';
import { openStorage } from '../src/storage/index';
import { lifecycleBackend } from '../src/storage/lifecycle-store';
import { noticeTemplate } from '../src/storage/notice-types';
import { tokenBudgetStore, tokenBudgetWindowMs } from '../src/storage/token-budget-store';
import { authConfig } from './helpers/authorization-fixture';
import { storageFixture } from './helpers/storage-fixture';
import { scopeFor } from './helpers/connection-scope';
import { queueMessage } from './helpers/chat-queue';

const at = Date.parse('2026-11-23T12:00:00Z');
const owner = 73;
const group = 314;
const logger: SafeLogger = { event() {}, componentError() {}, debugError() {}, debugText() {} };
const answer = {
  kind: 'complete',
  text: 'Тестовый ответ',
  usage: { input: 77, output: 3 },
} as const;
const refusal = noticeTemplate('token_budget_exhausted');

test('прямой отказ делит период уведомлений, а личная сводка доступна только владельцу после перезапуска', async () => {
  const files = storageFixture();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(at);
  const storage = await openStorage(files.path);
  const budget = tokenBudgetStore(storage);
  const config = loadApplicationConfig({
    env: {
      VK_TOKEN: 'synthetic-vk',
      VK_GROUP_ID: String(group),
      BOT_OWNER_ID: `vk:${owner}`,
      DATABASE_PATH: files.path,
      OPENCODE_API_KEY: 'synthetic-go',
      LLM_MODEL: 'synthetic-model',
      MODEL_CONTEXT_TOKENS: '16000',
      MESSAGE_RETENTION_DAYS: '30',
      LLM_SESSION_SECRET: 'synthetic-session',
    },
    readFile: () => '',
  }).config;
  const path = join(files.directory, 'prompt.txt');
  const records = new Map<string, Record<string, unknown>>();
  const sends: { peer: number; text: string }[] = [];
  let serial = 1;
  let tick = 0;
  let listener: Parameters<VkPollTransport['run']>[0];
  const complete = vi.fn<() => Promise<LlmResult>>(async () => answer);
  let shutdown: (() => Promise<void>) | undefined;
  const api = createVkApi(
    group,
    createVkApiCall(
      async (method, args) => {
        if (method === 'users.get') {
          return {
            response: String(args.user_ids)
              .split(',')
              .map((id) => ({ id: Number(id), first_name: 'Тест' })),
          };
        }
        if (method === 'messages.getConversationsById') {
          return {
            response: {
              items: [{ peer: { id: Number(args.peer_ids) }, can_write: { allowed: true } }],
            },
          };
        }
        if (method === 'messages.getByConversationMessageId') {
          return {
            response: {
              items: String(args.conversation_message_ids)
                .split(',')
                .map((id) => records.get(`${args.peer_id}:${id}`))
                .filter(Boolean),
            },
          };
        }
        if (method === 'messages.setActivity') return { response: 1 };
        if (method === 'messages.isMessagesFromGroupAllowed')
          return { response: { is_allowed: 1 } };
        if (method !== 'messages.send') throw Error('Неожиданный метод VK');
        const peer = Number(args.peer_ids);
        const text = String(args.message);
        sends.push({ peer, text });
        if (text === answer.text) return { error: { error_code: 900 } };
        const forward =
          args.forward === undefined
            ? null
            : (JSON.parse(String(args.forward)) as { conversation_message_ids: number[] });
        const row = {
          peer_id: peer,
          conversation_message_id: ++serial,
          from_id: -group,
          text,
          date: at / 1000,
          ...(forward
            ? { reply_message: records.get(`${peer}:${forward.conversation_message_ids[0]}`) }
            : {}),
        };
        records.set(`${peer}:${row.conversation_message_id}`, row);
        return { response: [row] };
      },
      createVkRateLimiter({
        now: () => tick,
        wait: async (ms) => {
          tick += ms;
        },
      }),
    ),
  );

  async function start() {
    const ready = Promise.withResolvers<void>();
    const signal = new AbortController();
    const transport: VkPollTransport = {
      async run(callbacks, running) {
        listener = callbacks;
        await callbacks.onGap('startup');
        callbacks.onReady?.();
        ready.resolve();
        if (!running.aborted)
          await new Promise<void>((resolve) =>
            running.addEventListener('abort', () => resolve(), { once: true }),
          );
      },
    };
    const run = runApplication(config, logger, signal.signal, {
      vk: { api, transport },
      client: { complete },
    });
    shutdown = async () => {
      signal.abort();
      expect(await run).toBeNull();
    };
    await ready.promise;
  }

  function submit(author: number, text: string) {
    const id = ++serial;
    const message = {
      peer_id: author,
      from_id: author,
      conversation_message_id: id,
      date: at / 1000,
      text,
    };
    records.set(`${author}:${id}`, message);
    listener.onUpdates([{ type: 'message_new', group_id: group, object: { message } }]);
  }
  const reports = () => sends.filter(({ text }) => text.startsWith('Расход за 24 часа'));

  try {
    await writeFile(path, 'Синтетическая инструкция.');
    expect(await initializePrompt(config, path)).toBeNull();
    await start();
    const chat = 'vk:55';
    await resolveApplicationChat(
      { databasePath: files.path, ownerId: config.authorization.ownerId },
      chat,
      'new',
    );
    const scope = scopeFor(storage, chat);
    budget.update(scope, false, { total: 0 }, at);
    submit(55, 'Синтетическое обращение');
    await vi.waitFor(async () => {
      expect((await storage.traces.get(scope, 1))?.payload.publication.status).toBe('delivered');
    });
    submit(55, 'Повторное обращение');
    await vi.waitFor(async () => {
      expect((await storage.traces.get(scope, 2))?.payload.publication.reason).toBe(
        'notice_period',
      );
    });
    expect(sends.filter(({ text }) => text === refusal)).toHaveLength(1);
    expect(complete).not.toHaveBeenCalled();

    budget.update(scope, false, { total: 10000 }, at);
    submit(55, 'Ещё один вопрос');
    await vi.waitFor(async () => {
      expect((await storage.traces.get(scope, 3))?.payload.publication.status).toBe('failed');
    });
    expect(complete).toHaveBeenCalledOnce();
    expect(budget.read(scope, false, at).total).toMatchObject({ confirmed: 80n, reserved: 0n });

    expect(
      budget.reserve(
        scope,
        false,
        {
          key: 'profile-test',
          purpose: 'profile_update',
          input: 21,
          output: 9,
        },
        at,
      ),
    ).toBe(true);
    expect(budget.reconcile(scope, 'profile-test', { input: 15, output: 2 })).toBe(true);
    submit(55, 'показать расход');
    submit(owner, 'показать расход');
    await vi.waitFor(() => expect(reports()).toHaveLength(1));
    expect(reports()[0]).toMatchObject({
      peer: owner,
      text: expect.stringContaining('подтверждено 97 из 10000'),
    });
    expect(reports()[0]?.text).toContain('Обновление профилей — подтверждено 17 из 500');
    expect(reports()[0]?.text).toContain('2026-11-23T12:00:00.000Z');
    expect(reports()[0]?.text).not.toContain('Синтетическое обращение');
    await shutdown?.();
    await start();
    submit(owner, 'Показать расход');
    await vi.waitFor(() => expect(reports()).toHaveLength(2));
    expect(reports()[1]).toEqual(reports()[0]);
    expect(complete).toHaveBeenCalledOnce();
  } finally {
    await shutdown?.();
    await storage.close();
    clock.mockRestore();
    files.cleanup();
  }
});

test('изменение обоих лимитов доступно владельцу в выбранном поколении и переживает рестарт', async () => {
  const files = storageFixture();
  let storage = await openStorage(files.path);
  let authorization: Awaited<ReturnType<typeof createAuthorizationService>> | undefined;
  const isGroupChat = (chatId: string) => chatId === 'vk:group';
  try {
    const scope = scopeFor(storage, 'vk:group');
    const neighbor = scopeFor(storage, 'vk:neighbor');
    await storage.chats.create(scope, { enabled: true, responseMode: 'active', createdAt: 0 });
    await storage.chats.create(neighbor, { enabled: true, responseMode: 'normal', createdAt: 0 });
    await storage.authorization.transaction(scope, (tx) =>
      tx.grant({
        userId: 'vk:admin',
        basis: 'explicit',
        grantedBy: authConfig.ownerId,
        grantedAt: at,
      }),
    );
    authorization = await createAuthorizationService({
      store: storage.authorization,
      config: authConfig,
    });
    const administration = createTokenBudgetAdministration({
      storage,
      authorization,
      isGroupChat,
      now: () => at,
    });
    const ownerContext = authorization.context({
      scope,
      userId: authConfig.ownerId,
      kind: 'owner',
    });
    const admin = authorization.context({ scope, userId: 'vk:admin' });
    const member = authorization.context({ scope, userId: 'vk:member' });
    for (const context of [admin, member]) {
      expect((await administration.read(context)).allowed).toBe(false);
      expect((await administration.update(context, { total: 0 }, () => true)).allowed).toBe(false);
      expect(administration.overview(context.userId).allowed).toBe(false);
    }
    const store = tokenBudgetStore(storage);
    store.finishObservation(scope, store.beginObservation(scope), {
      complete: true,
      people: 5,
      members: Array.from({ length: 5 }, (_, i) => ({ userId: `vk:${i + 1}`, role: 'unknown' })),
    });
    expect(
      store.reserve(scope, true, { key: 'i', purpose: 'initiative', input: 15, output: 7 }, at),
    ).toBe(true);
    expect(
      await administration.update(ownerContext, { total: 6000, initiative: 5000 }, () => true),
    ).toMatchObject({
      allowed: true,
      value: { total: { limit: 6000, reserved: 22n }, initiative: { limit: 5000, reserved: 22n } },
    });
    expect(store.read(neighbor, false, at).total.limit).toBe(500000);

    authorization.dispose();
    await storage.close();
    storage = await openStorage(files.path);
    authorization = await createAuthorizationService({
      store: storage.authorization,
      config: authConfig,
    });
    const reopened = createTokenBudgetAdministration({
      storage,
      authorization,
      isGroupChat,
      now: () => at,
    });
    const current = scopeFor(storage, scope.chatId);
    const owner = authorization.context({
      scope: current,
      userId: authConfig.ownerId,
      kind: 'owner',
    });
    expect(await reopened.read(owner)).toMatchObject({
      allowed: true,
      value: { total: { limit: 6000, reserved: 22n }, initiative: { limit: 5000, reserved: 22n } },
    });
    expect(
      await reopened.update(owner, { total: null, initiative: null }, () => true),
    ).toMatchObject({
      allowed: true,
      value: { total: { limit: 75000 }, initiative: { limit: 10000 } },
    });
    const lifecycle = lifecycleBackend(storage);
    lifecycle.ownerDecision(lifecycle.begin(scope.chatId), 'new');
    await expect(reopened.update(owner, { total: 1 }, () => true)).rejects.toThrow('stale_scope');
  } finally {
    authorization?.dispose();
    await storage.close();
    files.cleanup();
  }
});

test('исчерпание инициативы сохраняет прямой ответ, а отказ ограничен F4.5', async () => {
  const storage = await openStorage(':memory:');
  const scope = scopeFor(storage, 'vk:group');
  const budget = tokenBudgetStore(storage);
  const complete = vi.fn(async (): Promise<LlmResult> => answer);
  const publish = vi.fn<
    NonNullable<Parameters<typeof createPublicationService>[0]['port']>['publish']
  >(async (request) => {
    if (!request.beforeSend?.()) return { kind: 'failed' };
    request.confirmPart({
      messageId: 'bot-answer',
      userId: 'vk:bot',
      timestamp: Date.now(),
      authorName: '',
      text: request.text,
      ...(request.replyToMessageId ? { replyToMessageId: request.replyToMessageId } : {}),
    });
    return { kind: 'delivered', confirmedParts: 1 };
  });
  const publication = createPublicationService({
    storage,
    responseBudget: () => queue.responseBudget,
    port: {
      async canReply() {
        return true;
      },
      publish,
    },
  });
  const activeRoute = { kind: 'mention', mode: 'active', isGroupChat: true } as const;
  const queue = createAgentLoopQueue({
    storage,
    tokenBudget: true,
    responseRate: responseRateConfig({ responsesPerMinute: 1 }),
    tracing: { messageRetentionDays: 30 },
    modelName: 'synthetic',
    prepare: async () => ({
      kind: 'ready',
      input: {
        system: '',
        messages: [{ role: 'user', text: 'Вопрос' }],
        maxOutputTokens: 10,
        sessionId: 'test',
      },
    }),
    client: { complete },
    onSettled: publication.onSettled,
  });
  try {
    await storage.chats.create(scope, { enabled: true, responseMode: 'active', createdAt: 0 });
    const now = Date.now();
    expect(
      budget.reserve(
        scope,
        true,
        { key: 'initiative', purpose: 'initiative', input: 8000, output: 2000 },
        now,
      ),
    ).toBe(true);
    expect(
      budget.reserve(scope, true, { key: 'next', purpose: 'initiative', input: 1, output: 1 }, now),
    ).toBe(false);
    expect(
      publicationDecision(
        activeRoute,
        { enabled: true, responseMode: 'active' },
        { kind: 'initiative_budget_exhausted' },
      ),
    ).toEqual({ kind: 'silence' });
    expect(budget.read(scope, true, now).total.remaining).toBe(5000);
    await queue.start();
    const send = (id: string) =>
      queue.admitRouted(scope, queueMessage(scope.chatId, id), () => ({
        reason: 'mention',
        route: activeRoute,
      }));
    await send('1');
    await vi.waitFor(async () => {
      expect((await storage.traces.get(scope, 1))?.payload.publication.status).toBe('delivered');
    });
    expect(complete).toHaveBeenCalledOnce();
    expect(budget.read(scope, true, Date.now()).total).toMatchObject({
      confirmed: 80n,
      reserved: 10000n,
    });
    budget.update(scope, true, { total: 0 }, Date.now());
    await send('2');
    await vi.waitFor(async () => {
      expect((await storage.traces.get(scope, 2))?.payload.publication).toMatchObject({
        rowId: 'token_budget_exhausted',
        status: 'suppressed',
        reason: 'response_rate',
      });
    });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenCalledOnce();
    expect(budget.read(scope, true, now + tokenBudgetWindowMs).initiative?.remaining).toBe(10000);
  } finally {
    await queue.stop();
    await storage.close();
  }
});
