import Database from 'better-sqlite3';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import { runApplication } from '../../src/app/service';
import { initializePrompt, resolveApplicationChat } from '../../src/app/setup';
import { createVkApi, createVkApiCall } from '../../src/channels/vk/api';
import type { VkPollTransport } from '../../src/channels/vk/long-poll';
import { createVkRateLimiter } from '../../src/channels/vk/rate-limit';
import { loadApplicationConfig } from '../../src/config/application';
import type { ChatId } from '../../src/contracts/index';
import type { LlmRequest, LlmResult } from '../../src/llm/types';
import type { SafeLogger } from '../../src/logger/index';
import { disclosureStore } from '../../src/storage/chat-disclosure-store';
import { openStorage } from '../../src/storage/index';
import { lifecycleBackend } from '../../src/storage/lifecycle-store';
import { answer, chat, group, ownerId, until } from './application-response-fixture';
import { storageFixture } from './storage-fixture';

interface Message {
  readonly from_id: number;
  readonly peer_id: number;
  readonly conversation_message_id: number;
  readonly date: number;
  readonly text: string;
  readonly random_id?: number;
  readonly reply_message?: Message;
}

export async function remindersFixture(origin = Date.UTC(2026, 10, 23, 20, 55)) {
  let now = origin;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const files = storageFixture();
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
    },
    readFile: () => '',
  });
  const path = join(files.directory, 'prompt.txt');
  await writeFile(path, 'Проверочная инструкция.');
  expect(await initializePrompt(config, path)).toBeNull();
  const storage = await openStorage(files.path);
  const db = new Database(files.path);
  const life = lifecycleBackend(storage);
  const disclosure = disclosureStore(storage);
  const version = disclosure.register(
    {
      provider: 'OpenCode Go',
      dataPolicy: 'history',
      storagePolicy: 'test',
      detailsText: 'Проверочная формулировка',
      detailsUrl: 'https://example.test/info',
      ownerContact: 'Тест',
      change: 'material',
    },
    origin,
  );
  const logs = vi.fn();
  const logger: SafeLogger = {
    event: logs,
    componentError: logs,
    debugError: logs,
    debugText: logs,
  };
  const complete = vi.fn<(request: LlmRequest) => Promise<LlmResult>>(async () => answer);
  const messages = new Map<number, Message>();
  const sends: Message[] = [];
  const closed = new Set<number>();
  const hidden = new Set<number>();
  const holds: (() => void)[] = [];
  let serial = 0;
  let tick = 0;
  let lostText: string | undefined;
  let hideText: string | undefined;
  let holdNext = false;
  let listener: Parameters<VkPollTransport['run']>[0];
  let running: ReturnType<typeof runApplication> | undefined;
  let stop: AbortController | undefined;
  const rate = createVkRateLimiter({
    now: () => tick,
    wait: async (ms) => {
      tick += ms;
    },
  });

  const attempt = vi.fn<Parameters<typeof createVkApiCall>[0]>(async (method, args) => {
    switch (method) {
      case 'users.get':
        return {
          response: String(args.user_ids)
            .split(',')
            .map((id) => ({ id: Number(id), first_name: 'Тест' })),
        };
      case 'messages.isMessagesFromGroupAllowed':
        return { response: { is_allowed: Number(!closed.has(Number(args.user_id))) } };
      case 'messages.getConversationsById':
        return {
          response: {
            items: [
              {
                peer: { id: Number(args.peer_ids) },
                can_write: { allowed: !closed.has(Number(args.peer_ids)) },
                chat_settings: { state: 'in' },
              },
            ],
          },
        };
      case 'messages.getConversationMembers':
        return { response: { items: [{ member_id: -group, is_admin: true }] } };
      case 'messages.getByConversationMessageId':
        return {
          response: {
            items: String(args.conversation_message_ids)
              .split(',')
              .map(Number)
              .filter((id) => !hidden.has(id))
              .map((id) => messages.get(id))
              .filter(Boolean),
          },
        };
      case 'messages.setActivity':
        return { response: 1 };
      case 'messages.send': {
        const parent = args.forward
          ? messages.get(
              (JSON.parse(String(args.forward)) as { conversation_message_ids: number[] })
                .conversation_message_ids[0]!,
            )
          : undefined;
        const row: Message = {
          from_id: -group,
          peer_id: Number(args.peer_ids),
          conversation_message_id: ++serial,
          date: Math.floor(now / 1000),
          text: String(args.message),
          random_id: Number(args.random_id),
          ...(parent ? { reply_message: parent } : {}),
        };
        messages.set(row.conversation_message_id, row);
        sends.push(row);
        if (hideText && row.text.includes(hideText)) hidden.add(row.conversation_message_id);
        if (lostText && row.text.includes(lostText)) throw Error('Синтетическая потеря ответа');
        return { response: [row] };
      }
      default:
        throw Error('Неожиданный вызов VK');
    }
  });
  const api = createVkApi(
    group,
    createVkApiCall(attempt, async (call, guard) => {
      if (guard?.beforeSend && holdNext) {
        holdNext = false;
        const pause = Promise.withResolvers<void>();
        holds.push(pause.resolve);
        await pause.promise;
      }
      return rate(call, guard);
    }),
  );
  async function launch() {
    stop = new AbortController();
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
    running = runApplication(config, logger, stop.signal, {
      vk: { api, transport },
      client: { complete },
      onboardingIntervalMs: 5,
      reminderIntervalMs: 5,
    });
    await ready.promise;
  }
  async function halt() {
    stop?.abort();
    for (const release of holds.splice(0)) release();
    expect(await running).toBeNull();
  }
  async function resolve(chatId: ChatId, decision: 'continue' | 'new' = 'continue') {
    await resolveApplicationChat({ databasePath: files.path, ownerId }, chatId, decision);
    return life.current(chatId);
  }
  function deliver(row: Message) {
    listener.onUpdates([{ type: 'message_new', group_id: group, object: { message: row } }]);
  }
  try {
    await launch();
    const scope = await resolve(chat, 'new');
    await until(() => expect(disclosure.gate(scope).version).toBe(version));
    sends.length = 0;
    return {
      clock,
      db,
      sends,
      complete,
      logs,
      attempt,
      scope,
      storage,
      origin,
      life,
      holds,
      resolve,
      launch,
      halt,
      at(value: number) {
        db.prepare(
          'UPDATE queue_lease SET expires_at=max(expires_at,?) WHERE token IS NOT NULL',
        ).run(value + 30_000);
        now = value;
      },
      send(text: string, from = 41, destination = from, timestamp = now, reply?: Message) {
        const row: Message = {
          from_id: from,
          peer_id: destination,
          text,
          date: Math.floor(timestamp / 1000),
          conversation_message_id: ++serial,
          ...(reply ? { reply_message: reply } : {}),
        };
        messages.set(row.conversation_message_id, row);
        deliver(row);
        return row;
      },
      repeat: deliver,
      privateAccess(user: number, allowed: boolean) {
        if (allowed) closed.delete(user);
        else closed.add(user);
      },
      lost(text: string) {
        lostText = text;
      },
      hide(text: string) {
        hideText = text;
      },
      hideMessage(messageId: number) {
        hidden.add(messageId);
      },
      reveal() {
        hidden.clear();
        hideText = undefined;
      },
      hold() {
        holdNext = true;
      },
      pending() {
        return db
          .prepare(
            'SELECT id,chat_id AS chatId,text,state,due_at AS dueAt,timezone,finished_at AS finishedAt FROM personal_reminders ORDER BY id',
          )
          .all() as {
          id: number;
          chatId: string;
          text: string | null;
          state: string;
          dueAt: number | null;
          timezone: string | null;
          finishedAt: number | null;
        }[];
      },
      async close() {
        try {
          await halt();
        } finally {
          db.close();
          await storage.close();
          clock.mockRestore();
          files.cleanup();
        }
      },
    };
  } catch (error) {
    await halt();
    db.close();
    await storage.close();
    clock.mockRestore();
    files.cleanup();
    throw error;
  }
}

export { chat, mention, peer, until } from './application-response-fixture';
