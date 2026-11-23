import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { runApplication } from '../src/app/service';
import { initializePrompt, resolveApplicationChat } from '../src/app/setup';
import { createVkApi, createVkApiCall } from '../src/channels/vk/api';
import type { VkPollTransport } from '../src/channels/vk/long-poll';
import { createVkRateLimiter } from '../src/channels/vk/rate-limit';
import { loadApplicationConfig } from '../src/config/application';
import { createLifecycleService } from '../src/core/index';
import type { LlmResult } from '../src/llm/types';
import type { SafeLogger } from '../src/logger/index';
import { chatControlStore } from '../src/storage/chat-control-store';
import { disclosureStore } from '../src/storage/chat-disclosure-store';
import { openStorage } from '../src/storage/index';
import { storageFixture } from './helpers/storage-fixture';

const group = 314,
  peer = 2000000041,
  owner = 73,
  administrator = 31,
  member = 55;
const chat = `vk:${peer}` as const,
  ownerId = `vk:${owner}` as const;
const logger: SafeLogger = { event() {}, componentError() {}, debugError() {}, debugText() {} };
const answer = (text: string): LlmResult => ({
  kind: 'complete',
  text,
  usage: { input: 1, output: 1 },
});

test('команды VK сохраняют паузу, выключение отменяет старую работу, объяснение остаётся в личке', async () => {
  const files = storageFixture();
  const config = loadApplicationConfig({
    env: {
      VK_TOKEN: 'test-vk',
      VK_GROUP_ID: String(group),
      BOT_OWNER_ID: ownerId,
      DATABASE_PATH: files.path,
      OPENCODE_API_KEY: 'test-go',
      LLM_MODEL: 'test-model',
      MODEL_CONTEXT_TOKENS: '16000',
      MESSAGE_RETENTION_DAYS: '30',
      LLM_SESSION_SECRET: 'test-session',
    },
    readFile: () => '',
  }).config;
  const prompt = join(files.directory, 'prompt.txt');
  await writeFile(prompt, 'Синтетическая инструкция.');
  expect(await initializePrompt(config, prompt)).toBeNull();
  const storage = await openStorage(files.path);
  const life = createLifecycleService({
    storage,
    ownerId,
    source: {
      async observe() {
        return { confidence: 'unavailable', bot: 'unknown' };
      },
    },
  });
  const disclosure = disclosureStore(storage);
  const version = disclosure.register(
    {
      provider: 'OpenCode Go',
      dataPolicy: 'history',
      storagePolicy: 'test',
      detailsText: 'Тестовое раскрытие',
      detailsUrl: 'https://example.test/details',
      ownerContact: 'Тестовый контакт',
      change: 'material',
    },
    Date.now(),
  );
  const controls = chatControlStore(storage);
  const messages = new Map<string, Record<string, unknown>>();
  const oldResponse = Promise.withResolvers<LlmResult>(),
    entered = Promise.withResolvers<void>();
  const beforeRevocation = Promise.withResolvers<void>(),
    afterRevocation = Promise.withResolvers<void>();
  const checkedAfterRevocation = Promise.withResolvers<void>();
  let holdAdmin = false;
  const model = vi
    .fn<() => Promise<LlmResult>>()
    .mockImplementationOnce(async () => {
      entered.resolve();
      return oldResponse.promise;
    })
    .mockResolvedValue(answer('Новый синтетический ответ'));
  let at = 0,
    cmid = 1000;
  const attempt = vi.fn<Parameters<typeof createVkApiCall>[0]>(async (method, args) => {
    if (method === 'users.get')
      return {
        response: String(args.user_ids)
          .split(',')
          .map((id) => ({ id: Number(id), first_name: 'Тест' })),
      };
    if (method === 'messages.getConversationsById') {
      const destination = Number(args.peer_ids);
      return {
        response: {
          items: [
            {
              peer: { id: destination },
              can_write: { allowed: true },
              chat_settings: { state: 'in' },
            },
          ],
        },
      };
    }
    if (method === 'messages.getConversationMembers')
      return { response: { items: [{ member_id: -group, is_admin: true }] } };
    if (method === 'messages.isMessagesFromGroupAllowed') return { response: { is_allowed: 1 } };
    if (method === 'messages.setActivity') return { response: 1 };
    if (method === 'messages.getByConversationMessageId')
      return {
        response: {
          items: String(args.conversation_message_ids)
            .split(',')
            .map((id) => messages.get(`${args.peer_id}:${id}`))
            .filter(Boolean),
        },
      };
    if (method === 'messages.send') {
      const destination = Number(args.peer_ids);
      const forward =
        args.forward === undefined
          ? undefined
          : (JSON.parse(String(args.forward)) as { conversation_message_ids: number[] });
      const row = {
        from_id: -group,
        peer_id: destination,
        conversation_message_id: ++cmid,
        text: args.message,
        date: Math.floor(Date.now() / 1000),
        ...(forward
          ? { reply_message: messages.get(`${destination}:${forward.conversation_message_ids[0]}`) }
          : {}),
      };
      messages.set(`${destination}:${cmid}`, row);
      return { response: [row] };
    }
    throw new Error('Неожиданный запрос VK');
  });
  const apiCall = createVkApiCall(
    attempt,
    createVkRateLimiter({
      now: () => at,
      wait: async (ms) => {
        at += ms;
      },
    }),
  );
  const api = createVkApi(group, async (method, args, guard) => {
    const delayed =
      holdAdmin && method === 'messages.send' && Number(args.peer_ids) === administrator;
    if (delayed) {
      beforeRevocation.resolve();
      await afterRevocation.promise;
    }
    try {
      return await apiCall(method, args, guard);
    } finally {
      if (delayed) checkedAfterRevocation.resolve();
    }
  });
  const ready = Promise.withResolvers<void>(),
    stop = new AbortController();
  let listener: Parameters<VkPollTransport['run']>[0];
  const transport: VkPollTransport = {
    async run(callbacks, signal) {
      listener = callbacks;
      await callbacks.onGap('startup');
      callbacks.onReady?.();
      ready.resolve();
      if (!signal.aborted)
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
    },
  };
  function event(
    id: number,
    text: string,
    author = member,
    destination = peer,
    reply?: { conversation_message_id: number; from_id: number; date: number },
  ) {
    const message = {
      peer_id: destination,
      from_id: author,
      conversation_message_id: id,
      text,
      out: 0,
      date: Math.floor(Date.now() / 1000),
      ...(reply ? { reply_message: reply } : {}),
    };
    messages.set(`${destination}:${id}`, message);
    listener.onUpdates([{ type: 'message_new', group_id: group, object: { message } }]);
    return { conversation_message_id: id, from_id: author, date: message.date };
  }
  const sent = () =>
    attempt.mock.calls.filter(([method]) => method === 'messages.send').map(([, args]) => args);
  const run = runApplication(config, logger, stop.signal, {
    vk: { api, transport },
    client: { complete: model },
    onboardingIntervalMs: 5,
  });
  try {
    await ready.promise;
    await resolveApplicationChat({ databasePath: files.path, ownerId }, chat, 'new');
    const scope = life.current(chat),
      target = `${chat}@${scope.generation}`;
    await vi.waitFor(() => expect(disclosure.gate(scope).version).toBe(version));
    await storage.authorization.transaction(scope, (tx) =>
      tx.grant({
        userId: `vk:${administrator}`,
        basis: 'explicit',
        grantedAt: 1,
        grantedBy: ownerId,
      }),
    );
    event(201, '/тихие-часы 23:00-07:00', member);
    await vi.waitFor(async () =>
      expect(
        (await storage.messages.list(scope, { limit: 10 })).some((row) => row.messageId === '201'),
      ).toBe(true),
    );
    expect(controls.read(scope).quietHours).toBeNull();
    event(202, '/тихие-часы 23:00–07:00', administrator);
    await vi.waitFor(() =>
      expect(controls.read(scope).quietHours).toEqual({ start: 1380, end: 420 }),
    );
    event(203, '/тихие-часы выкл', administrator);
    await vi.waitFor(() => expect(controls.read(scope).quietHours).toBeNull());
    event(1, '/режим активный', member);
    event(2, '/режим активный', administrator);
    await vi.waitFor(() => expect(controls.read(scope).mode).toBe('active'));
    const neighbor = event(3, 'Обычный разговор', administrator);
    event(4, 'помолчи', member, peer, neighbor);
    await vi.waitFor(async () =>
      expect(
        (await storage.messages.list(scope, { limit: 30 })).some((row) => row.messageId === '4'),
      ).toBe(true),
    );
    expect(controls.read(scope).pausedUntil).toBeNull();
    event(5, 'помолчи');
    await vi.waitFor(() => expect(controls.read(scope).pausedUntil).not.toBeNull());
    await vi.waitFor(() =>
      expect(
        sent().some((row) => String(row.message).startsWith('Самостоятельные реплики на паузе')),
      ).toBe(true),
    );
    expect(
      String(
        sent().find((row) => String(row.message).startsWith('Самостоятельные реплики на паузе'))
          ?.message,
      ),
    ).not.toContain(target);
    const until = controls.read(scope).pausedUntil;
    event(6, 'помолчи', administrator);
    event(7, '[club314|Пенёк] Старый вопрос');
    await entered.promise;
    event(8, '[club314|Пенёк] Второй старый вопрос');
    await vi.waitFor(async () =>
      expect(
        (await storage.messages.list(scope, { limit: 30 })).some((row) => row.messageId === '8'),
      ).toBe(true),
    );
    event(9, '/выключить-бота', administrator);
    await vi.waitFor(() =>
      expect(controls.read(scope)).toMatchObject({
        enabled: false,
        mode: 'active',
        pausedUntil: until,
      }),
    );
    event(10, '[club314|Пенёк] При выключенном боте');
    event(11, `/включить-бота ${target}`, administrator, administrator);
    event(12, `/включить-бота ${target}`, owner, owner);
    await vi.waitFor(() => expect(controls.read(scope).enabled).toBe(true));
    oldResponse.resolve(answer('Старый ответ не должен уйти'));
    event(13, '[club314|Пенёк] Новый вопрос');
    await vi.waitFor(() =>
      expect(sent().some((row) => row.message === 'Новый синтетический ответ')).toBe(true),
    );
    await vi.waitFor(async () =>
      expect((await storage.traces.last(scope))?.payload.publication.status).toBe('delivered'),
    );
    expect(model).toHaveBeenCalledTimes(2);
    expect(sent().some((row) => row.message === 'Старый ответ не должен уйти')).toBe(false);
    expect(
      (await storage.messages.list(scope, { limit: 35 })).some((row) => row.messageId === '10'),
    ).toBe(false);
    expect(controls.read(scope)).toMatchObject({ mode: 'active', pausedUntil: until });

    event(14, `почему ты так ответил ${target}`, member, member);
    event(15, `почему ты так ответил ${target}`, administrator, administrator);
    await vi.waitFor(() =>
      expect(sent().filter((row) => String(row.message).includes('Повод ответа'))).toEqual([
        expect.objectContaining({
          peer_ids: String(administrator),
          message: expect.stringContaining('упоминание бота'),
        }),
      ]),
    );
    holdAdmin = true;
    event(16, `почему ты так ответил ${target}`, administrator, administrator);
    await beforeRevocation.promise;
    await storage.authorization.transaction(scope, (tx) => tx.remove(`vk:${administrator}`, false));
    afterRevocation.resolve();
    await checkedAfterRevocation.promise;
    expect(sent().filter((row) => String(row.message).includes('Повод ответа'))).toHaveLength(1);
  } finally {
    oldResponse.resolve(answer('Старый ответ'));
    afterRevocation.resolve();
    stop.abort();
    expect(await run).toBeNull();
    await storage.close();
    files.cleanup();
  }
  expect(sent().filter((row) => String(row.message).includes('Повод ответа'))).toHaveLength(1);
}, 12_000);
