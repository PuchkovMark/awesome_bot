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
import type { SafeLogger } from '../src/logger/index';
import { disclosureStore } from '../src/storage/chat-disclosure-store';
import { openStorage } from '../src/storage/index';
import { lifecycleBackend } from '../src/storage/lifecycle-store';
import { participantRegistryStore } from '../src/storage/participant-registry';
import { tokenBudgetStore } from '../src/storage/token-budget-store';
import { answer, group, mention, ownerId, until } from './helpers/application-response-fixture';
import { storageFixture } from './helpers/storage-fixture';

const start = Date.UTC(2026, 10, 23, 12);
const peer = 2_000_000_041;
const neighbor = peer + 1;
const chatId = (id: number) => `vk:${id}` as const;
const logger: SafeLogger = { event() {}, componentError() {}, debugError() {}, debugText() {} };
interface Row {
  readonly peer_id: number;
  readonly conversation_message_id: number;
  readonly from_id: number;
  readonly text: string;
  readonly date: number;
  readonly action?: { type: string; member_id: number };
  readonly reply_message?: Row;
}

async function fixture() {
  const files = storageFixture();
  let now = start;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
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
  const prompt = join(files.directory, 'prompt.txt');
  await writeFile(prompt, 'Проверочная инструкция.');
  expect(await initializePrompt(config, prompt)).toBeNull();
  const storage = await openStorage(files.path);
  const db = new Database(files.path);
  const life = lifecycleBackend(storage);
  const registry = participantRegistryStore(storage);
  const budgets = tokenBudgetStore(storage);
  const disclosure = disclosureStore(storage);
  const version = disclosure.register(
    {
      provider: 'OpenCode Go',
      dataPolicy: 'history',
      storagePolicy: 'test',
      detailsText: 'Тест',
      detailsUrl: 'https://example.test/info',
      ownerContact: 'Тест',
      change: 'material',
    },
    now,
  );
  const names = new Map([
    [peer, [41, 42]],
    [neighbor, [41]],
  ]);
  const restricted = new Set<number>();
  const pulls: { target: number; offset: number }[] = [];
  const complete = vi.fn(async () => answer);
  const rows = new Map<number, Row>();
  let serial = 0;
  let tick = 0;
  let pause: { target: number; wait: Promise<void>; release: () => void } | undefined;
  let callback: Parameters<VkPollTransport['run']>[0];
  let run: ReturnType<typeof runApplication> | undefined;
  let stop: AbortController | undefined;
  const api = createVkApi(
    group,
    createVkApiCall(
      async (method, args) => {
        const target = Number(args.peer_id);
        switch (method) {
          case 'users.get':
            return {
              response: String(args.user_ids)
                .split(',')
                .map((id) => ({ id: Number(id), first_name: 'Тест' })),
            };
          case 'messages.getConversationsById':
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
          case 'messages.getConversationMembers': {
            if (args.offset === undefined)
              return {
                response: { items: [{ member_id: -group, is_admin: !restricted.has(target) }] },
              };
            const offset = Number(args.offset);
            pulls.push({ target, offset });
            const roster = [-group, ...(names.get(target) ?? [])];
            if (pause?.target === target && offset === 0) {
              const held = pause;
              await held.wait;
            }
            if (restricted.has(target)) return { error: { error_code: 917 } };
            return {
              response: {
                count: roster.length,
                items: roster.slice(offset, offset + 2).map((member_id) => ({
                  member_id,
                  ...(member_id === 41 ? { is_admin: true } : {}),
                })),
              },
            };
          }
          case 'messages.getByConversationMessageId':
            return {
              response: {
                items: String(args.conversation_message_ids)
                  .split(',')
                  .map((id) => rows.get(Number(id)))
                  .filter(Boolean),
              },
            };
          case 'messages.setActivity':
            return { response: 1 };
          case 'messages.send': {
            const destination = Number(args.peer_ids);
            const parent = args.forward
              ? rows.get(
                  (JSON.parse(String(args.forward)) as { conversation_message_ids: number[] })
                    .conversation_message_ids[0]!,
                )
              : undefined;
            const row = {
              peer_id: destination,
              from_id: -group,
              conversation_message_id: ++serial,
              date: Math.floor(now / 1000),
              text: String(args.message),
              ...(parent ? { reply_message: parent } : {}),
            };
            rows.set(row.conversation_message_id, row);
            return { response: [row] };
          }
          default:
            throw Error('Неожиданный запрос VK');
        }
      },
      createVkRateLimiter({
        now: () => tick,
        wait: async (ms) => {
          tick += ms;
        },
      }),
    ),
  );
  async function ownerResume(target: number, decision: 'new' | 'continue' = 'continue') {
    const chat = chatId(target);
    await resolveApplicationChat({ databasePath: files.path, ownerId }, chat, decision);
  }
  async function launch() {
    stop = new AbortController();
    const ready = Promise.withResolvers<void>();
    const transport: VkPollTransport = {
      async run(callbacks, signal) {
        callback = callbacks;
        await callbacks.onGap('startup');
        callbacks.onReady?.();
        ready.resolve();
        if (!signal.aborted)
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
      },
    };
    run = runApplication(config, logger, stop.signal, {
      vk: { api, transport },
      client: { complete },
      membershipScanMs: 5,
      membershipStaggerMs: 0,
      administrationIntervalMs: 5,
      onboardingIntervalMs: 5,
    });
    await ready.promise;
  }
  async function halt() {
    stop?.abort();
    pause?.release();
    expect(await run).toBeNull();
  }
  function submit(row: Row) {
    rows.set(row.conversation_message_id, row);
    callback.onUpdates([{ type: 'message_new', group_id: group, object: { message: row } }]);
    return row;
  }
  try {
    // Первый штатный запуск должен сохранить паузу даже у ранее активных чатов.
    await ownerResume(peer, 'new');
    await ownerResume(neighbor, 'new');
    await launch();
    return {
      complete,
      at(at: number) {
        db.prepare(
          'UPDATE queue_lease SET expires_at=max(expires_at,?) WHERE token IS NOT NULL',
        ).run(at + 30_000);
        now = at;
      },
      full(target: number) {
        return pulls.filter((row) => row.target === target).map((row) => row.offset);
      },
      registry(target: number) {
        return registry.read(life.current(chatId(target)));
      },
      people(target: number) {
        return budgets.read(life.current(chatId(target)), true, now).people;
      },
      pauseStatus(target: number) {
        return life.pausedConnections('vk').some((row) => row.chatId === chatId(target));
      },
      restricted,
      names,
      version,
      disclosure,
      life,
      submit,
      event(target: number, action: Row['action'], actor = 42, text = '') {
        return submit({
          peer_id: target,
          conversation_message_id: ++serial,
          from_id: actor,
          text,
          date: Math.floor(now / 1000),
          ...(action ? { action } : {}),
        });
      },
      hold(target: number) {
        const pending = Promise.withResolvers<void>();
        pause = { target, wait: pending.promise, release: pending.resolve };
        return () => {
          pause = undefined;
          pending.resolve();
        };
      },
      ownerResume,
      halt,
      launch,
      async close() {
        try {
          await halt();
        } finally {
          db.close();
          await storage.close();
          files.cleanup();
          clock.mockRestore();
        }
      },
    };
  } catch (error) {
    await halt();
    db.close();
    await storage.close();
    files.cleanup();
    clock.mockRestore();
    throw error;
  }
}

test('две беседы получают по одному снимку, события и обычный ответ проходят во время чтения', async () => {
  const f = await fixture();
  try {
    expect(f.pauseStatus(peer)).toBe(true);
    expect(f.pauseStatus(neighbor)).toBe(true);
    expect(f.full(peer)).toEqual([]);
    await f.ownerResume(peer);
    await f.ownerResume(neighbor);
    await until(() => expect([f.people(peer), f.people(neighbor)]).toEqual([2, 1]));
    await until(() =>
      expect(f.disclosure.gate(f.life.current(chatId(peer))).version).toBe(f.version),
    );
    expect(f.full(peer)).toEqual([0, 2]);
    expect(f.full(neighbor)).toEqual([0]);
    f.at(start + 10_000);
    const release = f.hold(peer);
    const invite = f.event(peer, { type: 'chat_invite_user', member_id: 43 });
    await until(() => expect(f.full(peer)).toEqual([0, 2, 0]));
    f.submit(invite);
    f.at(start + 20_000);
    f.event(peer, { type: 'chat_kick_user', member_id: 41 });
    f.at(start + 30_000);
    f.event(peer, { type: 'chat_invite_user', member_id: 44 });
    expect(f.registry(peer).participants.find((row) => row.userId === 'vk:41')).toMatchObject({
      status: 'removed',
    });
    expect(f.registry(neighbor).participants.find((row) => row.userId === 'vk:41')).toMatchObject({
      status: 'present',
    });
    f.event(peer, undefined, 42, mention);
    await until(() => expect(f.complete).toHaveBeenCalledOnce());
    expect(f.registry(peer).participants.find((row) => row.userId === 'vk:42')).toMatchObject({
      lastSeenAt: start + 30_000,
    });
    expect(f.full(peer)).toEqual([0, 2, 0]);
    f.names.set(peer, [42]);
    release();
    await until(() => expect(f.people(peer)).toBe(1));
    expect(f.full(peer)).toEqual([0, 2, 0, 0]);
    expect(f.full(neighbor)).toEqual([0]);
    expect(f.registry(peer)).toMatchObject({ lastAttemptComplete: true, needsSync: false });
  } finally {
    await f.close();
  }
});

test('отказ завершает попытку, доступ и час запускают по одной сверке, рестарт оставляет паузу', async () => {
  const f = await fixture();
  try {
    f.restricted.add(peer);
    await f.ownerResume(peer);
    await until(() => expect(f.registry(peer).lastAttemptComplete).toBe(false));
    expect(f.people(peer)).toBeNull();
    expect(f.full(peer)).toEqual([0]);
    f.restricted.delete(peer);
    await until(() => expect(f.people(peer)).toBe(2));
    expect(f.full(peer)).toEqual([0, 0, 2]);
    f.at(start + 3_600_000 - 1);
    expect(f.full(peer)).toHaveLength(3);
    f.at(start + 3_600_000);
    await until(() => expect(f.registry(peer).lastCompleteAt).toBe(start + 3_600_000));
    expect(f.full(peer)).toEqual([0, 0, 2, 0, 2]);
    expect(f.full(neighbor)).toEqual([]);
    await f.halt();
    await f.launch();
    expect(f.pauseStatus(peer)).toBe(true);
    expect(f.pauseStatus(neighbor)).toBe(true);
    expect(f.full(peer)).toHaveLength(5);
    await f.ownerResume(peer);
    await until(() => expect(f.full(peer)).toHaveLength(7));
    expect(f.full(neighbor)).toEqual([]);
  } finally {
    await f.close();
  }
});
