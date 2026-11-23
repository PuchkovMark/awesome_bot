import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { runApplication } from '../src/app/service.js';
import { initializePrompt, resolveApplicationChat } from '../src/app/setup.js';
import { createVkApi, createVkApiCall } from '../src/channels/vk/api.js';
import type { VkPollTransport } from '../src/channels/vk/long-poll.js';
import { createVkRateLimiter } from '../src/channels/vk/rate-limit.js';
import { loadApplicationConfig } from '../src/config/application.js';
import type { ConnectionScope } from '../src/contracts/index.js';
import type { SafeLogger } from '../src/logger/index.js';
import { disclosureStore } from '../src/storage/chat-disclosure-store.js';
import { openStorage } from '../src/storage/index.js';
import { lifecycleBackend } from '../src/storage/lifecycle-store.js';
import { noticeTemplate } from '../src/storage/notice-types.js';
import { storageFixture } from './helpers/storage-fixture.js';

const group = 314;
const peer = 2000000041;
const ownerId = 'vk:73';
const chat = `vk:${peer}` as const;
const logger: SafeLogger = { event() {}, componentError() {}, debugError() {}, debugText() {} };

test('активная беседа получает один reply при серии превышений, а личка имеет собственную квоту', async () => {
  const files = storageFixture();
  const { config } = loadApplicationConfig({ env: { VK_TOKEN: 'test-vk', VK_GROUP_ID: String(group), BOT_OWNER_ID: ownerId,
    DATABASE_PATH: files.path, OPENCODE_API_KEY: 'test-go', LLM_MODEL: 'test-model', MODEL_CONTEXT_TOKENS: '16000',
    CHAT_MENTION_FLOOD_THRESHOLD: '100', MESSAGE_RETENTION_DAYS: '30', LLM_SESSION_SECRET: 'test-session' }, readFile: () => '' });
  const prompt = join(files.directory, 'prompt.txt');
  await writeFile(prompt, 'Синтетическая инструкция.');
  expect(await initializePrompt(config, prompt)).toBeNull();
  const storage = await openStorage(files.path);
  const disclosure = disclosureStore(storage);
  const version = disclosure.register({ provider: 'OpenCode Go', dataPolicy: 'history', storagePolicy: 'test',
    detailsText: 'Тестовое раскрытие', detailsUrl: 'https://example.test/details', ownerContact: 'Тестовый контакт', change: 'material' }, Date.now());

  type Row = { text: string; from_id: number; peer_id: number; conversation_message_id: number; date: number; reply_message?: Row };
  const messages = new Map<string, Row>();
  const ready = Promise.withResolvers<void>();
  let listener: Parameters<VkPollTransport['run']>[0];
  const transport: VkPollTransport = { async run(callbacks, signal) {
    listener = callbacks;
    await callbacks.onGap('startup');
    callbacks.onReady?.();
    ready.resolve();
    if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  } };
  let tick = 0;
  let serial = 1000;
  const attempt = vi.fn<Parameters<typeof createVkApiCall>[0]>(async (method, args) => {
    if (method === 'users.get') {
      return { response: String(args.user_ids).split(',').map(id => ({ id: Number(id), first_name: 'Тест' })) };
    }
    if (method === 'messages.getConversationsById') {
      return { response: { items: [{ peer: { id: Number(args.peer_ids) }, can_write: { allowed: true }, chat_settings: { state: 'in' } }] } };
    }
    if (method === 'messages.getConversationMembers') return { response: { items: [{ member_id: -group, is_admin: true }] } };
    if (method === 'messages.isMessagesFromGroupAllowed') return { response: { is_allowed: 1 } };
    if (method === 'messages.setActivity') return { response: 1 };
    if (method === 'messages.getByConversationMessageId') {
      return { response: { items: String(args.conversation_message_ids).split(',')
        .map(id => messages.get(`${args.peer_id}:${id}`)).filter(Boolean) } };
    }
    if (method === 'messages.send') {
      const destination = Number(args.peer_ids);
      if (destination === 42 && args.message === 'Синтетический ответ') return { error: { error_code: 15 } };
      const forward = args.forward === undefined ? undefined : JSON.parse(String(args.forward)) as { conversation_message_ids: number[] };
      const parent = forward && messages.get(`${destination}:${forward.conversation_message_ids[0]}`);
      const row: Row = { text: String(args.message), peer_id: destination, from_id: -group, conversation_message_id: ++serial,
        date: Math.floor(Date.now() / 1000), ...(parent ? { reply_message: parent } : {}) };
      messages.set(`${destination}:${serial}`, row);
      return { response: [row] };
    }
    throw new Error('Неожиданный запрос VK');
  });
  const api = createVkApi(group, createVkApiCall(attempt, createVkRateLimiter({ now: () => tick, wait: async ms => { tick += ms; } })));
  const complete = vi.fn(async () => ({ kind: 'complete', text: 'Синтетический ответ', usage: { input: 1, output: 1 } }) as const);
  const stop = new AbortController();
  const running = runApplication(config, logger, stop.signal, { vk: { api, transport }, client: { complete }, onboardingIntervalMs: 5,
    chatLimits: { userRequests: 1, chatRequests: 1 } });

  function submit(id: number, from: number, destination = peer, replyAvailable = true) {
    const text = destination === peer ? `[club314|Пенёк] Синтетический вопрос ${id}` : `Синтетический вопрос ${id}`;
    const message = { text, from_id: from, peer_id: destination, conversation_message_id: id, date: Math.floor(Date.now() / 1000), out: 0 };
    if (replyAvailable) messages.set(`${destination}:${id}`, message);
    listener.onUpdates([{ type: 'message_new', group_id: group, object: { message } }]);
  }
  function settled(scope: ConnectionScope, id: number, resultKind: string, status: string, reason = 'none') {
    return vi.waitFor(async () => {
      const trace = await storage.traces.last(scope);
      expect(trace?.payload).toMatchObject({ resultKind, publication: { status, reason } });
      const input = await storage.messages.get(scope, trace!.messageId);
      expect(input?.messageId).toBe(String(id));
    }, { interval: 5 });
  }

  try {
    await ready.promise;
    await resolveApplicationChat({ databasePath: files.path, ownerId }, chat, 'new');
    const scope = lifecycleBackend(storage).current(chat);
    await vi.waitFor(() => expect(disclosure.gate(scope).version).toBe(version));
    await storage.chats.update(scope, { responseMode: 'active' });
    submit(1, 41);
    await settled(scope, 1, 'complete', 'delivered');
    submit(2, 42, peer, false);
    await settled(scope, 2, 'quota_exhausted', 'suppressed', 'no_reply');
    submit(3, 43);
    await settled(scope, 3, 'quota_exhausted', 'delivered');
    for (let id = 4; id <= 12; id++) {
      submit(id, 40 + id);
      await settled(scope, id, 'quota_exhausted', 'suppressed', 'notice_period');
    }
    const refusalText = noticeTemplate('quota_exhausted');
    const refusals = Array.from(messages.values()).filter(row => row.text === refusalText);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ peer_id: peer, reply_message: { conversation_message_id: 3 } });
    expect((await storage.messages.list(scope, { limit: 100 })).some(row => row.text === refusalText)).toBe(true);
    expect((await storage.contextMessages.list(scope, { limit: 100 })).some(row => row.text === refusalText)).toBe(false);
    expect(complete).toHaveBeenCalledTimes(1);

    await resolveApplicationChat({ databasePath: files.path, ownerId }, 'vk:41', 'new');
    const dm = lifecycleBackend(storage).current('vk:41');
    submit(1, 41, 41);
    await settled(dm, 1, 'complete', 'delivered');
    expect(complete).toHaveBeenCalledTimes(2);

    await resolveApplicationChat({ databasePath: files.path, ownerId }, 'vk:42', 'new');
    const closedDelivery = lifecycleBackend(storage).current('vk:42');
    submit(1, 42, 42);
    await settled(closedDelivery, 1, 'complete', 'failed', 'publication_failed');
    submit(2, 42, 42);
    await settled(closedDelivery, 2, 'quota_exhausted', 'delivered');
    expect(complete).toHaveBeenCalledTimes(3);
  } finally {
    stop.abort();
    expect(await running).toBeNull();
    await storage.close();
    files.cleanup();
  }
}, 12_000);
