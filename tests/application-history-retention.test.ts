import Database from 'better-sqlite3';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { runApplication } from '../src/app/service';
import { initializePrompt, resolveApplicationChat } from '../src/app/setup';
import { createVkApi, createVkApiCall } from '../src/channels/vk/api';
import type { VkPollTransport } from '../src/channels/vk/long-poll';
import { createVkRateLimiter } from '../src/channels/vk/rate-limit';
import { loadApplicationConfig } from '../src/config/application';
import type { LlmClient, LlmResult } from '../src/llm/types';
import type { SafeLogger } from '../src/logger/index';
import { disclosureStore } from '../src/storage/chat-disclosure-store';
import { openStorage } from '../src/storage/index';
import { lifecycleBackend } from '../src/storage/lifecycle-store';
import { storageFixture } from './helpers/storage-fixture';

const group = 314,
  peer = 2000000041,
  owner = 73,
  admin = 31,
  member = 55;
const chat = `vk:${peer}` as const,
  ownerId = `vk:${owner}` as const;
const day = 86_400_000;
const epoch = 1_800_000_000_000;
const logger: SafeLogger = { event() {}, componentError() {}, debugError() {}, debugText() {} };
const answer = (text: string): LlmResult => ({
  kind: 'complete',
  text,
  usage: { input: 1, output: 1 },
});

async function retentionApp(client: LlmClient, beforeSend?: (text: string) => void) {
  const files = storageFixture();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(epoch);
  const config = (days: number) =>
    loadApplicationConfig({
      env: {
        VK_TOKEN: 'test-vk',
        VK_GROUP_ID: String(group),
        BOT_OWNER_ID: ownerId,
        DATABASE_PATH: files.path,
        OPENCODE_API_KEY: 'test-go',
        LLM_MODEL: 'test-model',
        MODEL_CONTEXT_TOKENS: '16000',
        MESSAGE_RETENTION_DAYS: String(days),
        LLM_SESSION_SECRET: 'test-session',
      },
      readFile: () => '',
    }).config;
  const prompt = join(files.directory, 'prompt.txt');
  await writeFile(prompt, 'Синтетическая инструкция.');
  expect(await initializePrompt(config(30), prompt)).toBeNull();
  const storage = await openStorage(files.path);
  const db = new Database(files.path);
  const life = lifecycleBackend(storage),
    disclosure = disclosureStore(storage);
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
    epoch,
  );
  type VkRow = {
    text: string;
    from_id: number;
    peer_id: number;
    conversation_message_id: number;
    date: number;
    reply_message?: VkRow;
    out?: number;
  };
  const messages = new Map<string, VkRow>();
  let serial = 1000,
    tick = 0;
  const attempt = vi.fn<Parameters<typeof createVkApiCall>[0]>(async (method, args) => {
    if (method === 'users.get')
      return {
        response: String(args.user_ids)
          .split(',')
          .map((id) => ({ id: Number(id), first_name: 'Тест' })),
      };
    if (method === 'messages.getConversationsById')
      return {
        response: {
          items: [
            {
              peer: { id: Number(args.peer_ids) },
              can_write: { allowed: true },
              chat_settings: { state: 'in' },
            },
          ],
        },
      };
    if (method === 'messages.getConversationMembers')
      return {
        response: {
          items: [
            {
              member_id: -group,
              is_admin: true,
            },
            { member_id: admin },
          ],
        },
      };
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
      const parent =
        forward && messages.get(`${destination}:${forward.conversation_message_ids[0]}`);
      const row = {
        text: String(args.message),
        peer_id: destination,
        from_id: -group,
        conversation_message_id: ++serial,
        date: Math.floor(Date.now() / 1000),
        ...(parent ? { reply_message: parent } : {}),
      };
      messages.set(`${destination}:${serial}`, row);
      return { response: [row] };
    }
    throw new Error('Неожиданный запрос VK');
  });
  const call = createVkApiCall(
    attempt,
    createVkRateLimiter({
      now: () => tick,
      wait: async (ms) => {
        tick += ms;
      },
    }),
  );
  const api = createVkApi(group, (method, args, guard) => {
    if (method === 'messages.send') beforeSend?.(String(args.message));
    return call(method, args, guard);
  });
  let listener: Parameters<VkPollTransport['run']>[0];
  let run: ReturnType<typeof runApplication> | undefined, controller: AbortController | undefined;
  let first = true;
  async function start(days = 30) {
    const ready = Promise.withResolvers<void>();
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
    controller = new AbortController();
    run = runApplication(config(days), logger, controller.signal, {
      vk: { api, transport },
      client,
      onboardingIntervalMs: 5,
    });
    await Promise.race([
      ready.promise,
      run.then((result) => {
        throw new Error(`Application stopped: ${result}`);
      }),
    ]);
    await resolveApplicationChat(
      { databasePath: files.path, ownerId },
      chat,
      first ? 'new' : 'continue',
    );
    first = false;
    const scope = life.current(chat);
    await vi.waitFor(() => expect(disclosure.gate(scope).version).toBe(version), { interval: 5 });
    await storage.authorization.transaction(scope, (tx) =>
      tx.grant({
        userId: `vk:${admin}`,
        basis: 'explicit',
        grantedAt: Date.now(),
        grantedBy: ownerId,
      }),
    );
    return scope;
  }
  async function stop() {
    controller?.abort();
    if (run) expect(await run).toBeNull();
    run = undefined;
  }
  function submit(message: VkRow) {
    messages.set(`${message.peer_id}:${message.conversation_message_id}`, message);
    listener.onUpdates([{ type: 'message_new', group_id: group, object: { message } }]);
  }
  function event(
    id: number,
    text: string,
    author = member,
    destination = peer,
    timestamp = Date.now(),
    reply?: VkRow,
  ) {
    const row = {
      text,
      from_id: author,
      peer_id: destination,
      conversation_message_id: id,
      date: Math.floor(timestamp / 1000),
      out: 0,
      ...(reply ? { reply_message: reply } : {}),
    };
    submit(row);
    return row;
  }
  function sent() {
    return attempt.mock.calls
      .filter(([method]) => method === 'messages.send')
      .map(([, args]) => args);
  }
  async function findReply(prefix: string, destination = peer) {
    return vi.waitFor(
      () => {
        const row = sent()
          .filter(
            (row) => row.peer_ids === String(destination) && String(row.message).startsWith(prefix),
          )
          .at(-1);
        expect(row).toBeDefined();
        return String(row!.message);
      },
      { interval: 5 },
    );
  }
  async function waitForMessage(id: string) {
    return vi.waitFor(
      () => {
        const row = db
          .prepare('SELECT id FROM messages WHERE chat_id=? AND platform_message_id=?')
          .get(chat, id) as { id: number } | undefined;
        expect(row).toBeDefined();
        return row!.id;
      },
      { interval: 5 },
    );
  }
  return {
    clock,
    storage,
    db,
    start,
    stop,
    submit,
    event,
    sent,
    findReply,
    waitForMessage,
    async close() {
      try {
        await stop();
      } finally {
        clock.mockRestore();
        db.close();
        await storage.close();
        files.cleanup();
      }
    },
  };
}

test('истёкшая цитата ещё в SQLite при позднем ответе — 0 отправок, 1 вызов, 1 начисление', async () => {
  const inModel = Promise.withResolvers<void>(),
    response = Promise.withResolvers<LlmResult>();
  const complete = vi.fn<LlmClient['complete']>(() => {
    inModel.resolve();
    return response.promise;
  });
  const app = await retentionApp({ complete });
  try {
    const scope = await app.start();
    const quote = app.event(1, 'Синтетическая цитата', member, peer, epoch - 30 * day + 1000);
    const quoteId = await app.waitForMessage('1');
    app.event(2, '[club314|Пенёк] Ответь на цитату', member, peer, epoch, quote);
    await inModel.promise;
    expect(JSON.stringify(complete.mock.calls[0]?.[0])).toContain('Синтетическая цитата');
    const sendsBefore = app.sent().length;
    app.clock.mockReturnValue(epoch + 1000);
    expect(await app.storage.messages.get(scope, quoteId)).toBeNull();
    response.resolve(answer('Этот ответ нельзя отправлять'));
    const job = await vi.waitFor(
      () => {
        const row = app.db
          .prepare("SELECT id,outcome FROM queue_jobs WHERE state='terminal'")
          .get();
        expect(row).toMatchObject({ outcome: 'interrupted' });
        return row as { id: number };
      },
      { interval: 5 },
    );
    expect(app.sent()).toHaveLength(sendsBefore);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(app.db.prepare('SELECT job_id FROM request_quota_admissions').all()).toEqual([
      { job_id: job.id },
    ]);
    expect(app.db.prepare("SELECT id FROM messages WHERE platform_message_id='1'").get()).toEqual({
      id: quoteId,
    });
  } finally {
    response.resolve(answer('Поздний ответ'));
    await app.close();
  }
}, 12_000);

test('владелец очищает выключенную беседу из лички; свежий повтор отсекается только ключом', async () => {
  const complete = vi.fn<LlmClient['complete']>().mockResolvedValue(answer('Новый ответ'));
  const app = await retentionApp({ complete });
  try {
    const scope = await app.start();
    const old = app.event(1, '[club314|Пенёк] Старое обращение');
    await app.waitForMessage('1');
    await app.findReply('Новый ответ');
    app.event(2, '/выключить-бота', admin);
    await vi.waitFor(async () => expect((await app.storage.chats.get(scope))?.enabled).toBe(false));
    const binding = `${chat}@${scope.generation}`;
    app.event(1, `/очистить-историю ${binding}`, owner, owner);
    const confirmation = await app.findReply(`Беседа ${binding}.`, owner);
    expect(confirmation).toContain('Сообщений к очистке: 3');
    expect(confirmation).toContain('Переписка в VK сохранится');
    app.event(2, `/подтвердить-очистку ${confirmation.slice(-32)}`, owner, owner);
    await app.findReply(`Очистка истории ${binding} подтверждена.`, owner);
    await vi.waitFor(() => expect(app.db.prepare('SELECT id FROM messages').all()).toEqual([]), {
      interval: 5,
    });
    expect((await app.storage.chats.get(scope))?.enabled).toBe(false);
    expect(
      app.db.prepare('SELECT expired_through FROM history_retention_boundaries').get(),
    ).toEqual({ expired_through: -1 });
    expect(
      app.db
        .prepare(
          "SELECT platform_message_id FROM history_deleted_inputs WHERE platform_message_id='1'",
        )
        .get(),
    ).toEqual({ platform_message_id: '1' });
    expect(complete).toHaveBeenCalledTimes(1);
    app.event(3, `/включить-бота ${binding}`, owner, owner);
    await vi.waitFor(async () => expect((await app.storage.chats.get(scope))?.enabled).toBe(true));
    app.submit(old);
    app.event(3, 'Обычное свежее сообщение');
    await app.waitForMessage('3');
    expect(app.db.prepare('SELECT platform_message_id FROM messages').all()).toEqual([
      { platform_message_id: '3' },
    ]);
    expect(app.db.prepare('SELECT id FROM queue_jobs').all()).toEqual([]);

    await app.stop();
    app.clock.mockReturnValue(epoch + 31 * day);
    const same = await app.start(90);
    expect(same.generation).toBe(scope.generation);
    app.submit(old);
    app.event(4, 'Свежее сообщение после перезапуска');
    await app.waitForMessage('4');
    expect(
      app.db.prepare("SELECT id FROM messages WHERE platform_message_id='1'").get(),
    ).toBeUndefined();
    expect(
      app.db
        .prepare(
          "SELECT platform_message_id FROM history_deleted_inputs WHERE platform_message_id='1'",
        )
        .get(),
    ).toEqual({ platform_message_id: '1' });
    expect(app.db.prepare('SELECT id FROM queue_jobs').all()).toEqual([]);
    expect(complete).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
  }
}, 12_000);

test('повтор после TTL и перехода 30 → 90 дней блокирует UTC-граница без ключа ручной очистки', async () => {
  const complete = vi
    .fn<LlmClient['complete']>()
    .mockResolvedValue(answer('Свежий ответ после перезапуска'));
  const app = await retentionApp({ complete });
  try {
    const scope = await app.start();
    const old = app.event(
      1,
      '[club314|Пенёк] Старое обращение',
      member,
      peer,
      epoch - 30 * day + 1000,
    );
    await app.waitForMessage('1');
    await app.findReply('Свежий ответ после перезапуска');
    await app.stop();
    app.clock.mockReturnValue(epoch + 1000);
    await app.start();
    expect(
      app.db.prepare("SELECT id FROM messages WHERE platform_message_id='1'").get(),
    ).toBeUndefined();
    expect(app.db.prepare('SELECT * FROM history_deleted_inputs').all()).toEqual([]);
    await app.stop();
    app.clock.mockReturnValue(old.date * 1000 + 31 * day);
    const same = await app.start(90);
    expect(same.generation).toBe(scope.generation);
    expect(app.db.prepare('SELECT retention_ms FROM history_retention_policy').get()).toEqual({
      retention_ms: 90 * day,
    });
    app.submit(old);
    app.event(2, '[club314|Пенёк] Свежее обращение');
    const newId = await app.waitForMessage('2');
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2), { interval: 5 });
    expect(
      app.db.prepare("SELECT id FROM messages WHERE platform_message_id='1'").get(),
    ).toBeUndefined();
    expect(app.db.prepare('SELECT message_id FROM queue_jobs').all()).toEqual([
      { message_id: newId },
    ]);
    expect(app.db.prepare('SELECT * FROM history_deleted_inputs').all()).toEqual([]);
  } finally {
    await app.close();
  }
}, 12_000);

test('администратор очищает беседу; повтор запроса сохраняет снимок, поздний вход остаётся', async () => {
  const complete = vi.fn<LlmClient['complete']>().mockResolvedValue(answer('Синтетический ответ'));
  const app = await retentionApp({ complete });
  try {
    const scope = await app.start();
    const binding = `${chat}@${scope.generation}`;
    app.event(1, 'Сообщение участника');
    app.event(2, '/очистить-историю', member);
    const request = app.event(3, '/очистить-историю', admin);
    const first = await app.findReply(`Беседа ${binding}.`);
    expect(first).toContain('Сообщений к очистке: 3');
    app.event(4, 'Новое сообщение');
    await app.waitForMessage('4');
    app.submit(request);
    await vi.waitFor(
      () => expect(app.sent().filter((row) => row.message === first)).toHaveLength(2),
      { interval: 5 },
    );
    app.event(5, `/подтвердить-очистку ${first.slice(-32)}`, admin);
    await app.findReply(`Очистка истории ${binding} подтверждена.`);
    expect(
      (await app.storage.messages.list(scope, { limit: 10 })).map((row) => row.messageId),
    ).toEqual(['4', '5']);
    await vi.waitFor(
      () =>
        expect(
          app.db.prepare('SELECT platform_message_id FROM messages ORDER BY id').all(),
        ).toEqual([{ platform_message_id: '4' }, { platform_message_id: '5' }]),
      { interval: 5 },
    );
    expect(complete).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

test('истечение источника перед второй частью в лимитере прекращает отправку и журналирование', async () => {
  const text = 'Первая часть ' + 'пример '.repeat(380) + 'Граница второй части';
  const complete = vi.fn<LlmClient['complete']>().mockResolvedValue(answer(text));
  const blocked = vi.fn();
  const app = await retentionApp({ complete }, (text) => {
    if (text.includes('Граница второй части')) {
      app.clock.mockReturnValue(epoch + 1000);
      blocked();
    }
  });
  try {
    const scope = await app.start();
    const quote = app.event(1, 'Синтетическая цитата', member, peer, epoch - 30 * day + 1000);
    await app.waitForMessage('1');
    app.event(2, '[club314|Пенёк] Ответь на цитату', member, peer, epoch, quote);
    await vi.waitFor(() => expect(blocked).toHaveBeenCalledTimes(1), { interval: 5 });
    await vi.waitFor(
      async () =>
        expect((await app.storage.traces.last(scope))?.payload.publication.reason).toBe(
          'partial_delivery',
        ),
      { interval: 5 },
    );
    expect(app.sent().filter((row) => String(row.message).startsWith('Первая часть'))).toHaveLength(
      1,
    );
    expect(app.sent().some((row) => String(row.message).includes('Граница второй части'))).toBe(
      false,
    );
    const history = await app.storage.messages.list(scope, { limit: 10 });
    expect(history.filter((row) => row.role === 'assistant')).toHaveLength(1);
    expect(complete).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
  }
}, 12_000);
