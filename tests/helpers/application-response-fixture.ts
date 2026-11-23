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
import type { LlmRequest, LlmResult } from '../../src/llm/types';
import type { TraceRecord } from '../../src/storage/trace-types';
import type { SafeLogger } from '../../src/logger/index';
import { disclosureStore } from '../../src/storage/chat-disclosure-store';
import { openStorage } from '../../src/storage/index';
import { lifecycleBackend } from '../../src/storage/lifecycle-store';
import { noticeTemplate } from '../../src/storage/notice-types';
import { storageFixture } from './storage-fixture';
import type { ChatLimits } from '../../src/core/chat-limits/config';
import type { QuestionnaireInvitationSource } from '../../src/core/greetings/invitation';

export const group = 314;
export const peer = 2_000_000_041;
export const chat = `vk:${peer}` as const;
export const ownerId = 'vk:73';
export const mention = '[club314|Пенёк] Вопрос';
export const refusal = noticeTemplate('mention_flood');
export const answer = {
  kind: 'complete',
  text: 'Синтетический ответ',
  usage: { input: 1, output: 1 },
} as const;
const logger: SafeLogger = { event() {}, componentError() {}, debugError() {}, debugText() {} };

export function until(check: () => void | Promise<void>) {
  return vi.waitFor(check, { interval: 5, timeout: 1800 });
}

export async function fixture(
  options: {
    limit?: number;
    profileNotice?: string;
    upload?: (peer: number, data: Buffer) => Promise<string>;
    threshold?: number;
    window?: number;
    hold?: boolean;
    userRequests?: number;
    active?: boolean;
    greetings?: {
      readonly members?: readonly number[];
      readonly rules?: string;
      readonly questionnaire?: QuestionnaireInvitationSource;
    };
    quotas?: Partial<ChatLimits>;
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
  db.pragma('foreign_keys=ON');
  const disclosure = disclosureStore(storage);
  const version = disclosure.register(
    {
      ...(options.profileNotice ? { profileNotice: options.profileNotice } : {}),
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
  let ready = Promise.withResolvers<void>();
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
    fwd_messages?: readonly unknown[];
    action?: { type: string; member_id?: number };
  };
  const messages = new Map<number, Message>();
  const names = new Map<number, { first_name: string; last_name: string }>();
  const sends: (Message & { readonly disableMentions: number; readonly sendId: number })[] = [];
  let members: readonly number[] | null = options.greetings?.members ?? null;
  const filesSent: { peer: number; attachment: string }[] = [];
  let privateAllowed = true;
  let serial = 0;
  let tick = 0;
  let sendFault:
    ((text: string) => number | 'unknown' | 'unknownAfterDelivery' | undefined) | undefined;
  let receiptHold:
    | {
        readonly match: (text: string) => boolean;
        readonly enter: () => void;
        readonly wait: Promise<void>;
        readonly release: () => void;
      }
    | undefined;
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
              .map((id) => ({ id: Number(id), first_name: 'Тест', ...names.get(Number(id)) })),
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
        if (method === 'messages.getConversationMembers') {
          const items = [
            { member_id: -group, is_admin: true },
            ...(members ?? []).map((member_id) => ({ member_id, is_admin: false })),
          ];
          return { response: { items, ...(members === null ? {} : { count: items.length }) } };
        }
        if (method === 'messages.getByConversationMessageId') {
          const items = String(args.conversation_message_ids)
            .split(',')
            .map((id) => messages.get(Number(id)))
            .filter((item) => item !== undefined);
          const hold = receiptHold;
          if (hold && items.some((item) => item.from_id === -group && hold.match(item.text))) {
            hold.enter();
            await hold.wait;
          }
          return { response: { items } };
        }
        if (method === 'messages.isMessagesFromGroupAllowed')
          return { response: { is_allowed: Number(privateAllowed) } };
        if (method === 'messages.send' && args.attachment) {
          filesSent.push({ peer: Number(args.peer_id), attachment: String(args.attachment) });
          return { response: ++serial };
        }
        if (method === 'messages.setActivity') return { response: 1 };
        if (method !== 'messages.send') throw new Error('Неожиданный метод тестового VK');
        const fault = sendFault?.(String(args.message));
        if (fault === 'unknown') throw Error('Синтетическая потеря квитанции');
        if (typeof fault === 'number') return { error: { error_code: fault } };
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
        sends.push({
          ...row,
          disableMentions: Number(args.disable_mentions),
          sendId: Number(args.random_id),
        });
        if (fault === 'unknownAfterDelivery')
          throw Error('Синтетическая потеря квитанции после отправки');
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
  let stop = new AbortController();
  const complete = vi.fn<(request: LlmRequest) => Promise<LlmResult>>(async () => answer);
  const launch = () =>
    runApplication(config, logger, stop.signal, {
      vk: {
        api: { ...api, ...(options.upload ? { uploadPrivateDocument: options.upload } : {}) },
        transport,
      },
      client: { complete },
      onboardingIntervalMs: 5,
      ...(options.greetings
        ? {
            greetingIntervalMs: 5,
            membershipScanMs: 10,
            membershipStaggerMs: 0,
            ...(options.greetings.rules ? { greetingRules: () => options.greetings!.rules } : {}),
            ...(options.greetings.questionnaire
              ? { questionnaireInvitations: options.greetings.questionnaire }
              : {}),
          }
        : {}),
      chatLimits: {
        userRequests: options.userRequests ?? 100,
        chatRequests: 100,
        ...options.quotas,
      },
    });
  let running = launch();
  async function close() {
    stop.abort();
    receiptHold?.release();
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
    if (options.active) await storage.chats.update(scope, { responseMode: 'active' });
    sends.length = 0;
    return {
      at(ms: number) {
        if (options.active || options.greetings) {
          // Промежуточные продления аренды при скачке управляемых часов.
          db.prepare(
            'UPDATE queue_lease SET expires_at=max(expires_at,?) WHERE token IS NOT NULL',
          ).run(start + ms + 30_000);
        }
        clock.mockReturnValue(start + ms);
        elapsed = ms;
      },
      sends,
      setPrivateAllowed(value: boolean) {
        privateAllowed = value;
      },
      setMembers(value: readonly number[] | null) {
        members = value;
      },
      membership(type: string, actor: number, member?: number, destination = peer) {
        const row: Message = {
          peer_id: destination,
          conversation_message_id: ++serial,
          from_id: actor,
          date: Math.floor(Date.now() / 1000),
          text: '',
          action: { type, ...(member === undefined ? {} : { member_id: member }) },
        };
        messages.set(row.conversation_message_id, row);
        listener.onUpdates([{ type: 'message_new', group_id: group, object: { message: row } }]);
        return row.conversation_message_id;
      },
      async restart(resume = false) {
        stop.abort();
        receiptHold?.release();
        for (const hold of holds) hold.release();
        expect(await running).toBeNull();
        ready = Promise.withResolvers<void>();
        stop = new AbortController();
        running = launch();
        await ready.promise;
        if (resume)
          await resolveApplicationChat({ databasePath: files.path, ownerId }, chat, 'continue');
      },
      async connectGroup(destination: number) {
        const id = `vk:${destination}` as const;
        await resolveApplicationChat({ databasePath: files.path, ownerId }, id, 'new');
        const connected = lifecycleBackend(storage).current(id);
        await until(() => expect(disclosure.gate(connected).version).toBe(version));
        return connected;
      },
      filesSent,
      holds,
      complete,
      db,
      storage,
      scope,
      start,
      holdReceipt(match: (text: string) => boolean) {
        const entered = Promise.withResolvers<void>();
        const gate = Promise.withResolvers<void>();
        const release = () => {
          receiptHold = undefined;
          gate.resolve();
        };
        receiptHold = { match, enter: entered.resolve, wait: gate.promise, release };
        return { entered: entered.promise, release };
      },
      failSend(fault: typeof sendFault) {
        sendFault = fault;
      },
      async trace(id: number): Promise<TraceRecord> {
        let result: Awaited<ReturnType<typeof storage.traces.get>> = null;
        await until(async () => {
          const job = db
            .prepare(
              `SELECT j.id FROM queue_jobs j JOIN messages m ON j.message_id=m.id
            WHERE j.chat_id=? AND m.platform_message_id=?`,
            )
            .get(chat, String(id)) as { id: number } | undefined;
          expect(job).toBeDefined();
          result = await storage.traces.get(scope, job!.id);
          expect(result?.finishedAt).not.toBeNull();
          expect(result?.payload.publication.status).toBeDefined();
          expect(result?.payload.publication.status).not.toBe('pending_checks');
          expect(result?.payload.publication.status).not.toBe('allowed');
        });
        return result!;
      },
      close,
      name(from: number, first: string, last = '') {
        names.set(from, { first_name: first, last_name: last });
      },
      replay(id: number) {
        const message = messages.get(id);
        if (message)
          listener.onUpdates([{ type: 'message_new', group_id: group, object: { message } }]);
      },
      submit(text: string, from = 41, parent?: Message, destination = peer, forwarded = false) {
        const row: Message = {
          peer_id: destination,
          conversation_message_id: ++serial,
          from_id: from,
          date: Math.floor(Date.now() / 1000),
          text,
          ...(parent ? { reply_message: parent } : {}),
          ...(forwarded ? { fwd_messages: [{}] } : {}),
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
