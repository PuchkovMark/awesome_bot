import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runApplication } from '../src/app/service';
import { initializePrompt, resolveApplicationChat } from '../src/app/setup';
import { createVkApi, createVkApiCall, type VkApiCall } from '../src/channels/vk/api';
import type { VkPollTransport } from '../src/channels/vk/long-poll';
import { createVkRateLimiter } from '../src/channels/vk/rate-limit';
import { loadApplicationConfig } from '../src/config/application';
import { createLifecycleService } from '../src/core/index';
import type { ConnectionScope } from '../src/contracts/index';
import type { LlmClient, LlmResult } from '../src/llm/types';
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

async function setupControlApplication(
  model: LlmClient['complete'],
  options: {
    wrapCall?: (call: VkApiCall) => VkApiCall;
    rejectSend?: (destination: number, text: string) => boolean;
  } = {},
) {
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
      if (options.rejectSend?.(destination, String(args.message)))
        return { error: { error_code: 15, error_msg: 'Access denied' } };
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
  const api = createVkApi(group, options.wrapCall?.(apiCall) ?? apiCall);
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
  function notify(message: Record<string, unknown>) {
    return listener.onUpdates([{ type: 'message_new', group_id: group, object: { message } }]);
  }
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
    return {
      reply: { conversation_message_id: id, from_id: author, date: message.date },
      handled: notify(message),
    };
  }
  const sent = () =>
    attempt.mock.calls.filter(([method]) => method === 'messages.send').map(([, args]) => args);
  const run = runApplication(config, logger, stop.signal, {
    vk: { api, transport },
    client: { complete: model },
    onboardingIntervalMs: 5,
  });
  return {
    files,
    storage,
    life,
    disclosure,
    version,
    controls,
    event,
    sent,
    ready: ready.promise,
    delivered: () => [...messages.values()].filter((row) => row.from_id === -group),
    replay(id: number, destination: number) {
      const message = messages.get(`${destination}:${id}`);
      if (!message) throw new Error('Нет исходного события VK');
      notify(message);
    },
    async close() {
      stop.abort();
      try {
        expect(await run).toBeNull();
      } finally {
        await storage.close();
        files.cleanup();
      }
    },
  };
}

test('строка из групповой справки открывает сводку выбранной беседы по действующим правам и поколению', async () => {
  const model = vi
    .fn<() => Promise<LlmResult>>()
    .mockResolvedValue(answer('Синтетическая реплика'));
  const f = await setupControlApplication(model);
  const neighborPeer = peer + 1;
  let nextEvent = 300;

  async function openGroup(destination: number) {
    const id = `vk:${destination}` as const;
    await resolveApplicationChat({ databasePath: f.files.path, ownerId }, id, 'new');
    const scope = f.life.current(id);
    await vi.waitFor(() => expect(f.disclosure.gate(scope).version).toBe(f.version));
    return scope;
  }

  async function request(input: string, actor: number, destination: number, prefix: string) {
    const before = f.delivered().length;
    expect(await f.event(nextEvent++, input, actor, destination).handled).toBe(true);
    const reply = () =>
      f
        .delivered()
        .slice(before)
        .find((row) => row.peer_id === destination && String(row.text).startsWith(prefix));
    await vi.waitFor(() => expect(reply()).toBeDefined());
    return String(reply()!.text);
  }

  async function copyCommand(scope: ConnectionScope, actor: number) {
    const destination = Number(scope.chatId.slice(3));
    const general = await request('/помощь', actor, destination, 'Доступные команды');
    const shortcut = general.match(/^\/помощь управление(?= — )/mu)?.[0];
    expect(shortcut).toBe('/помощь управление');
    const topic = await request(shortcut!, actor, destination, 'Управление\n');
    expect(topic).toContain('скопируйте следующую строку в личку сообщества');
    expect(topic).not.toContain('Повод ответа:');
    const command = topic.split('\n').find((line) => line.startsWith('почему ты так ответил '));
    expect(command).toBe(`почему ты так ответил ${scope.chatId}@${scope.generation}`);
    return command!;
  }

  async function deliverOrdinary(scope: ConnectionScope, text: string) {
    expect(await f.event(nextEvent++, text, member, Number(scope.chatId.slice(3))).handled).toBe(
      true,
    );
    await vi.waitFor(async () =>
      expect(
        (await f.storage.traces.last(scope))?.payload.publication.status,
        `${scope.chatId}@${scope.generation} · ${text}`,
      ).toBe('delivered'),
    );
  }

  async function withoutSummary(command: string, actor: number) {
    const before = f.sent().length;
    expect(await f.event(nextEvent++, command, actor, actor).handled).toBe(true);
    expect(f.sent()).toHaveLength(before);
  }

  const mentionReason = 'Повод ответа: упоминание бота.';
  const nameReason = 'Повод ответа: обращение по имени.';
  const empty = 'В этой беседе нет доступной сводки доставленного ответа.';
  try {
    await f.ready;
    const a = await openGroup(peer);
    const b = await openGroup(neighborPeer);
    expect(b.generation).not.toBe(a.generation);
    for (const scope of [a, b]) {
      await f.storage.authorization.transaction(scope, (tx) =>
        tx.grant({
          userId: `vk:${administrator}`,
          basis: 'explicit',
          grantedAt: 1,
          grantedBy: ownerId,
        }),
      );
    }
    const unpublished = await copyCommand(b, administrator);
    expect(await request(unpublished, administrator, administrator, empty)).toBe(empty);
    await deliverOrdinary(a, '[club314|Пенёк] Где начало встречи?');
    await deliverOrdinary(b, 'Пенёк, где встречаемся завтра?');

    const aCommand = await copyCommand(a, administrator);
    const bCommand = await copyCommand(b, administrator);
    await request(aCommand, administrator, administrator, mentionReason);
    await request(bCommand, administrator, administrator, nameReason);
    await request(await copyCommand(a, owner), owner, owner, mentionReason);
    const oldB = await copyCommand(b, owner);
    await request(oldB, owner, owner, nameReason);

    await withoutSummary(aCommand, member);
    await f.storage.authorization.transaction(b, (tx) => tx.remove(`vk:${administrator}`, false));
    await request(aCommand, administrator, administrator, mentionReason);
    await withoutSummary(bCommand, administrator);

    const fresh = await openGroup(neighborPeer);
    expect(fresh.generation).not.toBe(b.generation);
    await deliverOrdinary(fresh, '[club314|Пенёк] Какой сегодня план?');
    const freshCommand = await copyCommand(fresh, owner);
    await withoutSummary(oldB, owner);
    await request(freshCommand, owner, owner, mentionReason);

    const summaries = f
      .delivered()
      .filter((row) => String(row.text).startsWith('Повод ответа:'))
      .map((row) => [row.peer_id, String(row.text).split('\n')[0]]);
    expect(summaries).toEqual([
      [administrator, mentionReason],
      [administrator, nameReason],
      [owner, mentionReason],
      [owner, nameReason],
      [administrator, mentionReason],
      [owner, mentionReason],
    ]);
    expect(model).toHaveBeenCalledTimes(3);
  } finally {
    await f.close();
  }
}, 12_000);

test('команды VK сохраняют паузу, выключение отменяет старую работу, объяснение остаётся в личке', async () => {
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
  const { files, storage, life, disclosure, version, controls, event, sent, ready, close } =
    await setupControlApplication(model, {
      wrapCall: (apiCall) => async (method, args, guard) => {
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
      },
    });
  try {
    await ready;
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
    event(205, '/приветствие вкл', member);
    await vi.waitFor(async () =>
      expect(
        (await storage.messages.list(scope, { limit: 20 })).some((row) => row.messageId === '205'),
      ).toBe(true),
    );
    expect(controls.read(scope).greetingEnabledAt).toBeNull();
    event(206, '/приветствие вкл', administrator);
    await vi.waitFor(() => expect(controls.read(scope).greetingEnabledAt).not.toBeNull());
    const reopened = await openStorage(files.path);
    try {
      const registry = (await import('../src/storage/lifecycle-store')).lifecycleBackend(reopened);
      expect(chatControlStore(reopened).read(registry.current(chat)).greetingEnabledAt).toBe(
        controls.read(scope).greetingEnabledAt,
      );
    } finally {
      await reopened.close();
    }
    event(207, '/приветствие выкл', administrator);
    await vi.waitFor(() => expect(controls.read(scope).greetingEnabledAt).toBeNull());
    event(206, '/приветствие вкл', administrator);
    event(208, 'Маркер после повтора', administrator);
    await vi.waitFor(async () =>
      expect(
        (await storage.messages.list(scope, { limit: 20 })).some((row) => row.messageId === '208'),
      ).toBe(true),
    );
    expect(controls.read(scope).greetingEnabledAt).toBeNull();
    event(209, '/приглашение вкл', member);
    await vi.waitFor(async () =>
      expect(
        (await storage.messages.list(scope, { limit: 20 })).some((row) => row.messageId === '209'),
      ).toBe(true),
    );
    expect(controls.read(scope).invitationEnabledAt).toBeNull();
    event(210, '/приглашение вкл', administrator);
    await vi.waitFor(() => expect(controls.read(scope).invitationEnabledFrom).toBe(210));
    expect(controls.read(scope).greetingEnabledAt).toBeNull();
    event(211, '/приглашение выкл', administrator);
    await vi.waitFor(() => expect(controls.read(scope).invitationEnabledAt).toBeNull());
    event(210, '/приглашение вкл', administrator);
    event(212, 'Маркер после повтора приглашения', administrator);
    await vi.waitFor(async () =>
      expect(
        (await storage.messages.list(scope, { limit: 20 })).some((row) => row.messageId === '212'),
      ).toBe(true),
    );
    expect(controls.read(scope).invitationEnabledAt).toBeNull();
    event(213, '/вопросы', member);
    await vi.waitFor(async () =>
      expect(
        (await storage.messages.list(scope, { limit: 25 })).some((row) => row.messageId === '213'),
      ).toBe(true),
    );
    expect(sent().some((args) => String(args.message).includes('полным списком'))).toBe(false);
    event(214, '/вопросы изменить', administrator);
    await vi.waitFor(() =>
      expect(sent().some((args) => String(args.message).includes('полным списком'))).toBe(true),
    );
    event(270, '/режим', administrator);
    await vi.waitFor(() =>
      expect(
        sent().some(
          (row) =>
            String(row.message).includes('/режим молчаливый') &&
            String(row.message).includes('/режим нормальный') &&
            String(row.message).includes('/режим активный'),
        ),
      ).toBe(true),
    );
    event(271, '/часовой-пояс Ошибка', administrator);
    await vi.waitFor(() =>
      expect(
        sent().some((row) => String(row.message).includes('/часовой-пояс Europe/Moscow')),
      ).toBe(true),
    );
    event(272, '/часовой-пояс UTC', administrator);
    await vi.waitFor(() =>
      expect(sent().some((row) => String(row.message).includes('Часовой пояс сохранён: UTC'))).toBe(
        true,
      ),
    );
    event(273, '/тихие-часы 27:00 – 07:00', administrator);
    await vi.waitFor(() =>
      expect(sent().some((row) => String(row.message).includes('/тихие-часы 23:00–07:00'))).toBe(
        true,
      ),
    );
    expect(controls.read(scope).quietHours).toBeNull();
    event(274, '/настройки', administrator);
    await vi.waitFor(() =>
      expect(
        sent().some(
          (row) =>
            String(row.message).includes('Часовой пояс: UTC') &&
            String(row.message).includes('Тихие часы выключены') &&
            String(row.message).includes('Приветствия') &&
            String(row.message).includes('Приглашения к анкете'),
        ),
      ).toBe(true),
    );
    event(202, '/тихие-часы 23:00 – 07:00', administrator);
    await vi.waitFor(() =>
      expect(controls.read(scope).quietHours).toEqual({ start: 1380, end: 420 }),
    );
    event(203, `/тихие-часы ${target} выкл`, owner, owner);
    await vi.waitFor(() => expect(controls.read(scope).quietHours).toBeNull());
    event(1, '/режим активный', member);
    event(2, '/режим активный', administrator);
    await vi.waitFor(() => expect(controls.read(scope).mode).toBe('active'));
    const { reply: neighbor } = event(3, 'Обычный разговор', administrator);
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
    await vi.waitFor(async () =>
      expect(
        (await storage.messages.list(scope, { limit: 30 })).some((row) => row.messageId === '9'),
      ).toBe(true),
    );
    expect(controls.read(scope).enabled).toBe(true);
    event(204, `/выключить-бота ${target}`, owner, owner);
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
    await close();
  }
  expect(sent().filter((row) => String(row.message).includes('Повод ответа'))).toHaveLength(1);
}, 12_000);

test.each([
  { result: 'с подтверждением в личке', rejected: false },
  { result: 'при отказе VK отправить подтверждение', rejected: true },
])(
  'один локальный номер в трёх диалогах VK $result',
  async ({ rejected }) => {
    const model = vi.fn<() => Promise<LlmResult>>().mockResolvedValue(answer('Лишний ответ'));
    const f = await setupControlApplication(model, {
      rejectSend: (destination, text) =>
        rejected && destination === owner && text.includes('\nБот выключен.\n'),
    });
    const diagnostic = new Database(f.files.path, { readonly: true });
    try {
      await f.ready;
      const neighborPeer = peer + 1;
      const neighborChat = `vk:${neighborPeer}` as const;
      for (const id of [chat, neighborChat])
        await resolveApplicationChat({ databasePath: f.files.path, ownerId }, id, 'new');
      const a = f.life.current(chat);
      const b = f.life.current(neighborChat);
      const target = `${chat}@${a.generation}`;
      await vi.waitFor(() => {
        expect(f.disclosure.gate(a).version).toBe(f.version);
        expect(f.disclosure.gate(b).version).toBe(f.version);
      });
      const commands = diagnostic.prepare(
        'SELECT chat_id AS target, source_chat_id AS source, actor_id AS actor, message_id AS number FROM chat_control_commands ORDER BY chat_id,source_chat_id,message_id',
      );
      const hasDirectConnection = diagnostic.prepare(
        'SELECT 1 FROM chat_connections WHERE chat_id=?',
      );
      const receipt = (peerId: number, text: string) =>
        expect.objectContaining({ peer_id: peerId, text });
      const offText = `${target}\nБот выключен.\n`;
      const onText = `${target}\nБот включён.\n`;

      f.event(200, '/приветствие вкл', owner, peer);
      f.event(200, '/приветствие вкл', owner, neighborPeer);
      await vi.waitFor(() =>
        expect(f.delivered()).toEqual(
          expect.arrayContaining([
            receipt(peer, 'Приветствия включены.'),
            receipt(neighborPeer, 'Приветствия включены.'),
          ]),
        ),
      );
      const earlier = commands.all();
      expect(earlier).toEqual([
        { target: chat, source: chat, actor: ownerId, number: 200 },
        { target: neighborChat, source: neighborChat, actor: ownerId, number: 200 },
      ]);
      expect(hasDirectConnection.get(ownerId)).toBeUndefined();
      const sentBeforeOff = f.sent().length;
      const deliveredBeforeOff = f.delivered().length;
      f.event(199, `/выключить-бота ${target}`, member, member);
      f.event(199, `/выключить-бота ${chat}@${a.generation + 10}`, owner, owner);
      expect(f.controls.read(a).enabled).toBe(true);
      expect(commands.all()).toEqual(earlier);

      f.event(200, `/выключить-бота ${target}`, owner, owner);
      await vi.waitFor(() =>
        expect(f.sent().slice(sentBeforeOff)).toEqual([
          expect.objectContaining({
            peer_ids: String(owner),
            message: expect.stringContaining(offText),
          }),
        ]),
      );
      expect(f.delivered().slice(deliveredBeforeOff)).toEqual(
        rejected
          ? []
          : [expect.objectContaining({ peer_id: owner, text: expect.stringContaining(offText) })],
      );
      expect(hasDirectConnection.get(ownerId)).toBeUndefined();
      expect(f.controls.read(a).enabled).toBe(false);
      expect(f.controls.read(b)).toMatchObject({ enabled: true, greetingEnabledFrom: 200 });
      expect(commands.all()).toEqual([
        earlier[0],
        { target: chat, source: ownerId, actor: ownerId, number: 200 },
        earlier[1],
      ]);

      f.event(201, `/включить-бота ${target}`, owner, owner);
      await vi.waitFor(() =>
        expect(f.delivered()).toContainEqual(
          expect.objectContaining({ peer_id: owner, text: expect.stringContaining(onText) }),
        ),
      );
      f.event(201, '/приветствие выкл', owner, peer);
      f.event(201, '/приветствие выкл', owner, neighborPeer);
      await vi.waitFor(() =>
        expect(f.delivered()).toEqual(
          expect.arrayContaining([
            receipt(peer, 'Приветствия выключены.'),
            receipt(neighborPeer, 'Приветствия выключены.'),
          ]),
        ),
      );
      const saved = commands.all();
      const aState = f.controls.read(a);
      const bState = f.controls.read(b);
      expect(aState).toMatchObject({ enabled: true, greetingEnabledAt: null });
      expect(bState).toMatchObject({ enabled: true, greetingEnabledAt: null });
      const beforeChecks = f.delivered().length;
      const beforeAttempts = f.sent().length;
      f.replay(200, peer);
      f.replay(200, neighborPeer);
      f.replay(200, owner);
      f.event(202, '/настройки', owner, peer);
      f.event(202, '/настройки', owner, neighborPeer);
      f.event(202, `/настройки ${target}`, owner, owner);
      await vi.waitFor(() =>
        expect(f.delivered().slice(beforeChecks)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ peer_id: peer, text: expect.stringContaining(onText) }),
            expect.objectContaining({
              peer_id: neighborPeer,
              text: expect.stringContaining(`${neighborChat}@${b.generation}\nБот включён.\n`),
            }),
            expect.objectContaining({ peer_id: owner, text: expect.stringContaining(onText) }),
          ]),
        ),
      );
      expect(f.sent().slice(beforeAttempts)).toHaveLength(3);
      expect(f.controls.read(a)).toEqual(aState);
      expect(f.controls.read(b)).toEqual(bState);
      expect(commands.all()).toEqual(saved);
      for (const scope of [a, b]) {
        const journal = await f.storage.messages.list(scope, { limit: 20 });
        expect(journal.filter((row) => row.messageId === '200')).toMatchObject([
          { userId: ownerId, text: '/приветствие вкл' },
        ]);
      }
      expect(model).not.toHaveBeenCalled();
    } finally {
      diagnostic.close();
      await f.close();
    }
  },
  12_000,
);
