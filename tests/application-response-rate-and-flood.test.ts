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
import type { LlmResult } from '../src/llm/types';
import type { SafeLogger } from '../src/logger/index';
import { disclosureStore } from '../src/storage/chat-disclosure-store';
import { openStorage } from '../src/storage/index';
import { lifecycleBackend } from '../src/storage/lifecycle-store';
import { noticeTemplate } from '../src/storage/notice-types';
import { storageFixture } from './helpers/storage-fixture';

const group = 314;
const peer = 2_000_000_041;
const chat = `vk:${peer}` as const;
const ownerId = 'vk:73';
const mention = '[club314|Пенёк] Вопрос';
const refusal = noticeTemplate('mention_flood');
const answer = {
  kind: 'complete',
  text: 'Синтетический ответ',
  usage: { input: 1, output: 1 },
} as const;
const logger: SafeLogger = { event() {}, componentError() {}, debugError() {}, debugText() {} };

function until(check: () => void | Promise<void>) {
  return vi.waitFor(check, { interval: 5, timeout: 1800 });
}

async function fixture(
  options: {
    limit?: number;
    threshold?: number;
    window?: number;
    hold?: boolean;
    userRequests?: number;
  } = {},
) {
  const files = storageFixture();
  const clock = vi.spyOn(Date, 'now');
  const realMonotonic = performance.now.bind(performance);
  const monotonic = vi.spyOn(performance, 'now');
  let elapsed = 0;
  monotonic.mockImplementation(() => realMonotonic() + elapsed);
  const start = Date.UTC(2026, 10, 23, 12);
  clock.mockReturnValue(start);
  const { config } = loadApplicationConfig({
    env: {
      VK_TOKEN: 'synthetic-vk',
      VK_GROUP_ID: String(group),
      BOT_OWNER_ID: ownerId,
      DATABASE_PATH: files.path,
      OPENCODE_API_KEY: 'synthetic-go',
      LLM_MODEL: 'synthetic-model',
      MODEL_CONTEXT_TOKENS: '16000',
      MESSAGE_RETENTION_DAYS: '30',
      LLM_SESSION_SECRET: 'synthetic-session',
      CHAT_RESPONSES_PER_MINUTE: String(options.limit ?? 6),
      CHAT_MENTION_FLOOD_THRESHOLD: String(options.threshold ?? 5),
      CHAT_MENTION_FLOOD_WINDOW_MS: String(options.window ?? 10000),
    },
    readFile: () => '',
  });
  const path = join(files.directory, 'prompt.txt');
  await writeFile(path, 'Синтетическая инструкция.');
  expect(await initializePrompt(config, path)).toBeNull();

  const storage = await openStorage(files.path);
  const db = new Database(files.path);
  const disclosure = disclosureStore(storage);
  const version = disclosure.register(
    {
      provider: 'OpenCode Go',
      dataPolicy: 'history',
      storagePolicy: 'test',
      detailsText: 'Тестовая формулировка',
      detailsUrl: 'https://example.test/info',
      ownerContact: 'Тест',
      change: 'material',
    },
    start,
  );
  const ready = Promise.withResolvers<void>();
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

  type Message = {
    peer_id: number;
    conversation_message_id: number;
    from_id: number;
    date: number;
    text: string;
    reply_message?: Message;
  };
  const messages = new Map<number, Message>();
  const sends: Message[] = [];
  let serial = 0;
  let tick = 0;
  const holds: { release: () => void; finished: Promise<void> }[] = [];
  const limit = createVkRateLimiter({
    now: () => tick,
    wait: async (ms) => {
      tick += ms;
    },
  });
  const api = createVkApi(
    group,
    createVkApiCall(
      async (method, args) => {
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
          return { response: { items: [{ member_id: -group, is_admin: true }] } };
        if (method === 'messages.getByConversationMessageId')
          return {
            response: {
              items: String(args.conversation_message_ids)
                .split(',')
                .map((id) => messages.get(Number(id)))
                .filter(Boolean),
            },
          };
        if (method === 'messages.setActivity') return { response: 1 };
        if (method !== 'messages.send') throw new Error('Неожиданный метод тестового VK');
        const forward =
          args.forward === undefined
            ? undefined
            : (JSON.parse(String(args.forward)) as { conversation_message_ids: number[] });
        const parent = forward && messages.get(forward.conversation_message_ids[0]!);
        const row: Message = {
          peer_id: Number(args.peer_ids),
          conversation_message_id: ++serial,
          from_id: -group,
          date: Math.floor(Date.now() / 1000),
          text: String(args.message),
          ...(parent ? { reply_message: parent } : {}),
        };
        messages.set(row.conversation_message_id, row);
        sends.push(row);
        return { response: [row] };
      },
      async (call, guard) => {
        if (!options.hold || !guard?.beforeSend) return limit(call, guard);
        const pause = Promise.withResolvers<void>();
        const finished = Promise.withResolvers<void>();
        holds.push({ release: pause.resolve, finished: finished.promise });
        await pause.promise;
        try {
          return await limit(call, guard);
        } finally {
          finished.resolve();
        }
      },
    ),
  );
  const stop = new AbortController();
  const complete = vi.fn<() => Promise<LlmResult>>(async () => answer);
  const running = runApplication(config, logger, stop.signal, {
    vk: { api, transport },
    client: { complete },
    onboardingIntervalMs: 5,
    chatLimits: { userRequests: options.userRequests ?? 100, chatRequests: 100 },
  });
  async function close() {
    stop.abort();
    for (const hold of holds) hold.release();
    try {
      expect(await running).toBeNull();
    } finally {
      db.close();
      await storage.close();
      files.cleanup();
      clock.mockRestore();
      monotonic.mockRestore();
    }
  }
  try {
    await ready.promise;
    await resolveApplicationChat({ databasePath: files.path, ownerId }, chat, 'new');
    const scope = lifecycleBackend(storage).current(chat);
    await until(() => expect(disclosure.gate(scope).version).toBe(version));
    sends.length = 0;
    return {
      at(ms: number) {
        clock.mockReturnValue(start + ms);
        elapsed = ms;
      },
      sends,
      holds,
      complete,
      close,
      submit(text: string, from = 41, parent?: Message) {
        const row: Message = {
          peer_id: peer,
          conversation_message_id: ++serial,
          from_id: from,
          date: Math.floor(Date.now() / 1000),
          text,
          ...(parent ? { reply_message: parent } : {}),
        };
        messages.set(row.conversation_message_id, row);
        listener.onUpdates([{ type: 'message_new', group_id: group, object: { message: row } }]);
        return row.conversation_message_id;
      },
      journaled(id: number) {
        return until(async () =>
          expect(
            (await storage.messages.list(scope, { limit: 100 })).some(
              (row) => row.messageId === String(id),
            ),
          ).toBe(true),
        );
      },
      published(id: number) {
        return until(() =>
          expect(sends.some((item) => item.reply_message?.conversation_message_id === id)).toBe(
            true,
          ),
        );
      },
      suppressed(id: number) {
        return until(async () => {
          const trace = await storage.traces.last(scope);
          expect(trace?.payload.publication).toMatchObject({
            status: 'suppressed',
            reason: 'response_rate',
          });
          expect((await storage.messages.get(scope, trace!.messageId))?.messageId).toBe(String(id));
        });
      },
      interrupted(id: number) {
        return until(() => {
          const row = db
            .prepare(
              `SELECT j.outcome FROM queue_jobs j JOIN messages m ON j.message_id=m.id
            WHERE j.chat_id=? AND m.platform_message_id=?`,
            )
            .get(chat, String(id));
          expect(row).toEqual({ outcome: 'interrupted' });
        });
      },
      requests() {
        return db
          .prepare('SELECT count(*) FROM request_quota_admissions WHERE chat_id=?')
          .pluck()
          .get(chat);
      },
      slots() {
        return db
          .prepare('SELECT count(*) AS n FROM response_rate_publications WHERE chat_id=?')
          .pluck()
          .get(chat);
      },
      notices() {
        return db
          .prepare('SELECT count(*) AS n FROM notice_periods WHERE chat_id=?')
          .pluck()
          .get(chat);
      },
      seedSlots(n: number) {
        for (let i = 0; i < n; i++)
          db.prepare("INSERT INTO response_rate_publications VALUES(?,?,?,?,'delivered')").run(
            chat,
            scope.generation,
            `fixture:${i}`,
            start - 59000,
          );
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

test('reply боту без упоминания молчит в 35.999 и снова допускается ровно в 36.000', async () => {
  const f = await fixture({ limit: 20 });
  try {
    f.at(-1000);
    await f.published(f.submit('Пенёк, ответь'));
    const bot = f.sends[0]!;
    for (let time = 0; time <= 8000; time += 2000) {
      f.at(time);
      await f.published(f.submit(mention));
    }
    expect(f.sends.filter((row) => row.text === refusal)).toHaveLength(1);
    for (const time of [17000, 26000]) {
      f.at(time);
      await f.journaled(f.submit(mention));
    }
    f.at(35999);
    const suppressed = f.submit('Уточни ответ', 42, bot);
    await f.journaled(suppressed);
    expect(f.complete).toHaveBeenCalledTimes(5);
    expect(f.sends.some((row) => row.reply_message?.conversation_message_id === suppressed)).toBe(
      false,
    );
    f.at(36000);
    await f.published(f.submit('Уточни ответ', 42, bot));
    expect(f.complete).toHaveBeenCalledTimes(6);
    expect(f.sends.filter((row) => row.text === refusal)).toHaveLength(1);
    expect(f.sends.some((row) => row.reply_message?.conversation_message_id === suppressed)).toBe(
      false,
    );
  } finally {
    await f.close();
  }
});

test('отказ из первого всплеска после ожидания лимитера VK не тратит ресурсы второго', async () => {
  const f = await fixture({ threshold: 1, window: 1000, hold: true });
  try {
    f.submit(mention);
    await until(() => expect(f.holds).toHaveLength(1));
    f.at(1000);
    f.submit(mention);
    await until(() => expect(f.holds).toHaveLength(2));
    f.holds[0]!.release();
    await f.holds[0]!.finished;
    expect(f.sends).toHaveLength(0);
    expect(f.slots()).toBe(0);
    expect(f.notices()).toBe(0);
    expect(f.complete).toHaveBeenCalledTimes(0);
    f.holds[1]!.release();
    await until(() => expect(f.sends.map((row) => row.text)).toEqual([refusal]));
    expect(f.slots()).toBe(1);
    expect(f.notices()).toBe(1);
  } finally {
    await f.close();
  }
});

test.each([true, false])(
  'одно место и один победитель при порядке с отказом первым: %s',
  async (refusalFirst) => {
    const f = await fixture({ threshold: 1, hold: true });
    try {
      f.seedSlots(5);
      const model = Promise.withResolvers<LlmResult>();
      f.complete.mockImplementationOnce(() => model.promise);
      const ordinary = f.submit('Пенёк, ответь');
      await until(() => expect(f.complete).toHaveBeenCalledTimes(1));
      const flood = f.submit(mention, 42);
      await until(() => expect(f.holds).toHaveLength(1));
      model.resolve(answer);
      await until(() => expect(f.holds).toHaveLength(2));
      f.holds[refusalFirst ? 0 : 1]!.release();
      await f.published(refusalFirst ? flood : ordinary);
      f.holds[refusalFirst ? 1 : 0]!.release();
      await f.holds[refusalFirst ? 1 : 0]!.finished;
      expect(f.sends).toHaveLength(1);
      expect(f.slots()).toBe(6);
      expect(f.notices()).toBe(refusalFirst ? 1 : 0);
      f.at(1000);
      await f.journaled(f.submit(mention, 43));
      expect(f.sends).toHaveLength(1);
      expect(f.complete).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
    }
  },
);

test('полный предел подавляет оба коротких отказа, а нейтральное уведомление может стать седьмым', async () => {
  const f = await fixture({ threshold: 1, userRequests: 6 });
  const model = Promise.withResolvers<LlmResult>();
  try {
    for (let i = 0; i < 6; i++) await f.published(f.submit('Пенёк, ответь'));
    await f.suppressed(f.submit('Пенёк, ответь'));
    await f.journaled(f.submit(mention));
    expect(f.sends).toHaveLength(6);
    expect(f.slots()).toBe(6);
    expect(f.notices()).toBe(0);
    expect(f.complete).toHaveBeenCalledTimes(6);

    f.at(10000);
    f.complete.mockImplementationOnce(() => model.promise);
    f.submit('Пенёк, ответь', 51);
    await until(() => expect(f.complete).toHaveBeenCalledTimes(7));
    f.submit('Пенёк, ответь', 52);
    f.submit('Пенёк, ответь', 53);
    await f.published(f.submit('Пенёк, ответь', 54));
    expect(f.sends.map((row) => row.text)).toEqual([
      ...Array<string>(6).fill(answer.text),
      noticeTemplate('generic'),
    ]);
    expect(f.slots()).toBe(6);
    expect(f.notices()).toBe(1);
  } finally {
    model.resolve(answer);
    await f.close();
  }
});

test('всплеск подавляет ранее поставленное задание до списания F4.3', async () => {
  const f = await fixture({ threshold: 1 });
  const model = Promise.withResolvers<LlmResult>();
  try {
    f.complete.mockImplementationOnce(() => model.promise);
    const admitted = f.submit('Пенёк, ответь');
    await until(() => expect(f.complete).toHaveBeenCalledTimes(1));
    const queued = f.submit('Пенёк, ответь', 42);
    await f.journaled(queued);
    await f.published(f.submit(mention, 43));
    model.resolve(answer);
    await f.published(admitted);
    await f.interrupted(queued);
    expect(f.complete).toHaveBeenCalledTimes(1);
    expect(f.requests()).toBe(1);
    expect(f.sends.map((row) => row.text)).toEqual([refusal, answer.text]);
  } finally {
    model.resolve(answer);
    await f.close();
  }
});
