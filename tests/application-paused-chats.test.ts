import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { runApplication } from '../src/app/service';
import { initializePrompt, unconfirmedLifecycleSource } from '../src/app/setup';
import { createVkApi, createVkApiCall } from '../src/channels/vk/api';
import type { VkPollTransport } from '../src/channels/vk/long-poll';
import { vkMessageLength } from '../src/channels/vk/outbound-text';
import { createVkRateLimiter } from '../src/channels/vk/rate-limit';
import { loadApplicationConfig } from '../src/config/application';
import type { ChatId, ConnectionScope } from '../src/contracts/index';
import { createLifecycleService } from '../src/core/index';
import type { LlmResult } from '../src/llm/types';
import type { SafeLogger } from '../src/logger/index';
import { disclosureStore } from '../src/storage/chat-disclosure-store';
import { openConnection } from '../src/storage/connection';
import { openStorage } from '../src/storage/index';
import { storageFixture } from './helpers/storage-fixture';

const community = 314;
const owner = 73;
const ownerId = 'vk:73';
const administrator = 31;
const member = 55;
const logger: SafeLogger = { event() {}, componentError() {}, debugError() {}, debugText() {} };
const answer = 'Тестовый ответ модели';
const overview = 'Приостановленные беседы';
const firstPeer = 2_000_000_011;
const chat = (peer: number): ChatId => `vk:${peer}`;

async function fixture() {
  const files = storageFixture();
  const config = loadApplicationConfig({
    env: {
      VK_TOKEN: 'synthetic-vk',
      VK_GROUP_ID: String(community),
      BOT_OWNER_ID: ownerId,
      DATABASE_PATH: files.path,
      OPENCODE_API_KEY: 'synthetic-go',
      LLM_MODEL: 'synthetic-model',
      MODEL_CONTEXT_TOKENS: '16000',
      MESSAGE_RETENTION_DAYS: '30',
      LLM_SESSION_SECRET: 'synthetic-session',
    },
    readFile: () => '',
  }).config;
  const prompt = join(files.directory, 'prompt.txt');
  await writeFile(prompt, 'Синтетическая инструкция.');
  expect(await initializePrompt(config, prompt)).toBeNull();
  const storage = await openStorage(files.path);
  const connection = await openConnection(files.path);
  const life = createLifecycleService({ storage, ownerId, source: unconfirmedLifecycleSource });
  const records = new Map<string, Record<string, unknown>>();
  const sends: { peer: number; text: string }[] = [];
  const failed: { peer: number; text: string }[] = [];
  let writable = true;
  let denySend: (text: string) => boolean = () => false;
  let subscription: Parameters<VkPollTransport['run']>[0];
  let sequence = 100;
  let tick = 0;
  let stop: (() => Promise<void>) | undefined;
  const model = vi.fn(async (): Promise<LlmResult> => ({
    kind: 'complete',
    text: answer,
    usage: { input: 1, output: 1 },
  }));
  const attempt = vi.fn<Parameters<typeof createVkApiCall>[0]>(async (method, params) => {
    const peer = Number(params.peer_ids);
    if (method === 'messages.isMessagesFromGroupAllowed')
      return { response: { is_allowed: Number(writable) } };
    if (method === 'messages.getConversationsById')
      return {
        response: {
          items: [
            { peer: { id: peer }, can_write: { allowed: true }, chat_settings: { state: 'in' } },
          ],
        },
      };
    if (method === 'messages.getConversationMembers')
      return {
        response: {
          count: 2,
          items: [{ member_id: -community, is_admin: true }, { member_id: member }],
        },
      };
    if (method === 'users.get')
      return {
        response: String(params.user_ids)
          .split(',')
          .map((id) => ({ id: Number(id), first_name: 'Тест' })),
      };
    if (method === 'messages.getByConversationMessageId')
      return {
        response: {
          items: String(params.conversation_message_ids)
            .split(',')
            .map((cmid) => records.get(`${params.peer_id}:${cmid}`))
            .filter(Boolean),
        },
      };
    if (method === 'messages.setActivity') return { response: 1 };
    if (method !== 'messages.send') throw new Error('Неожиданный запрос к подмене VK');
    const text = String(params.message);
    if (denySend(text)) {
      failed.push({ peer, text });
      return { error: { error_code: 901 } };
    }
    sends.push({ peer, text });
    const forward =
      params.forward === undefined
        ? undefined
        : (JSON.parse(String(params.forward)) as { conversation_message_ids: number[] });
    const row = {
      peer_id: peer,
      from_id: -community,
      conversation_message_id: ++sequence,
      date: Math.floor(Date.now() / 1000),
      text,
      ...(forward
        ? { reply_message: records.get(`${peer}:${forward.conversation_message_ids[0]}`) }
        : {}),
    };
    records.set(`${peer}:${row.conversation_message_id}`, row);
    return { response: [row] };
  });
  const api = createVkApi(
    community,
    createVkApiCall(
      attempt,
      createVkRateLimiter({
        now: () => tick,
        async wait(ms) {
          tick += ms;
        },
      }),
    ),
  );
  const paused = () => life.pausedConnections('vk', ownerId);

  async function record(scope: ConnectionScope, messageId: string) {
    await storage.messages.append(scope, {
      chatId: scope.chatId,
      messageId,
      userId: chat(member),
      authorName: 'Тест',
      role: 'user',
      text: 'Прежняя синтетическая переписка',
      timestamp: Date.now(),
    });
  }
  function event(text: string, peer = owner, author = peer, extra: Record<string, unknown> = {}) {
    const id = ++sequence;
    const message = {
      peer_id: peer,
      from_id: author,
      conversation_message_id: id,
      date: Math.floor(Date.now() / 1000),
      text,
      ...extra,
    };
    records.set(`${peer}:${id}`, message);
    return { type: 'message_new', group_id: community, object: { message } };
  }

  return {
    path: files.path,
    storage,
    connection,
    life,
    model,
    sends,
    failed,
    attempt,
    paused,
    event,
    record,
    update(...events: unknown[]) {
      subscription.onUpdates(events);
    },
    gap() {
      return subscription.onGap('lost_position');
    },
    open(peer: number) {
      return life.decide(life.owner(chat(peer), ownerId), 'new');
    },
    allowPrivate(value: boolean) {
      writable = value;
    },
    failSend(predicate: (text: string) => boolean) {
      denySend = predicate;
    },
    async start(onboardingIntervalMs = 30_000) {
      const ready = Promise.withResolvers<void>();
      const controller = new AbortController();
      const transport: VkPollTransport = {
        async run(listener, signal) {
          subscription = listener;
          await listener.onGap('startup');
          listener.onReady?.();
          ready.resolve();
          if (!signal.aborted)
            await new Promise<void>((resolve) =>
              signal.addEventListener('abort', () => resolve(), { once: true }),
            );
        },
      };
      const run = runApplication(config, logger, controller.signal, {
        vk: { api, transport },
        client: { complete: model },
        onboardingIntervalMs,
      });
      stop = async () => {
        controller.abort();
        expect(await run).toBeNull();
      };
      await Promise.race([
        ready.promise,
        run.then((code) => {
          throw new Error(String(code));
        }),
      ]);
    },
    async stop() {
      await stop?.();
      stop = undefined;
    },
    async close() {
      try {
        await stop?.();
      } finally {
        connection.close();
        await storage.close();
        files.cleanup();
      }
    },
  };
}

test('после решения владельца участнику снова доступна справка в прежней личке', async () => {
  const f = await fixture();
  try {
    const original = f.open(member);
    await f.start();
    const paused = f.paused().find((item) => item.chatId === chat(member))!;
    expect(paused.generation).toBe(original.generation);
    f.update(f.event('Начать', member), f.event('/помощь', member), f.event(overview));
    await vi.waitFor(() => expect(f.sends.at(-1)?.peer).toBe(owner));
    expect(f.sends.filter((row) => row.peer === member)).toEqual([]);
    const command = 'Продолжить ' + paused.chatId + ' ' + paused.generation + '/' + paused.revision;
    expect(f.sends.at(-1)?.text).toContain(command);
    f.update(f.event(command));
    await vi.waitFor(() => expect(f.sends.at(-1)?.text).toContain(paused.chatId + ' продолжена'));
    f.update(f.event('Начать', member));
    await vi.waitFor(() =>
      expect(f.sends.at(-1)).toMatchObject({
        peer: member,
        text: expect.stringContaining('Доступные команды'),
      }),
    );
    expect(f.life.current(chat(member)).generation).toBe(original.generation);
    expect(f.model).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

test('ранний личный путь принимает целую команду владельца и закрыт для группы, посторонних, цитат и пересылок', async () => {
  const f = await fixture();
  try {
    await f.start();
    const ownerScope = f.open(owner);
    await f.storage.chats.create(ownerScope, {
      createdAt: Date.now(),
      responseMode: 'silent',
      enabled: false,
    });
    const group = f.open(firstPeer + 1);
    await f.storage.chats.create(group, {
      createdAt: Date.now(),
      responseMode: 'normal',
      enabled: true,
    });
    await f.storage.authorization.transaction(group, (tx) =>
      tx.grant({
        userId: chat(administrator),
        basis: 'explicit',
        grantedAt: 1,
        grantedBy: ownerId,
      }),
    );
    f.update(f.event('/помощь'));
    await vi.waitFor(() => expect(f.sends.at(-1)?.text).toContain('Приостановленные беседы'));
    expect(f.sends.at(-1)?.text).not.toContain('/анкета');
    f.sends.length = 0;
    f.update(f.event(overview));
    await vi.waitFor(() =>
      expect(f.sends).toEqual([{ peer: owner, text: 'Приостановленных бесед нет.' }]),
    );

    await f.life.verify(chat(firstPeer), 'first_seen');
    const previous = f.paused();
    const row = previous[0]!;
    expect(row.revision).toBe(0);
    const reset = `Начать заново ${row.chatId} ${row.generation}/0`;
    const allowedCalls = () =>
      f.attempt.mock.calls.filter(([method]) => method === 'messages.isMessagesFromGroupAllowed');
    const rightsBefore = allowedCalls().length;
    f.update(
      f.event(overview, member),
      f.event(reset, member),
      f.event(overview, administrator),
      f.event(reset, administrator),
      f.event(overview, firstPeer + 1, owner),
      f.event(reset, firstPeer + 1, owner),
      f.event(overview, owner, member),
      f.event(reset, owner, owner, {
        reply_message: { conversation_message_id: 1, from_id: member },
      }),
      f.event(reset, owner, owner, { fwd_messages: [{ text: reset }] }),
      f.event(`[club${community}|Бот] ${reset}`),
      f.event('', owner, owner, { fwd_messages: [{ text: reset }] }),
    );
    expect(f.paused()).toEqual(previous);

    f.update(f.event(`Продолжить ${row.chatId} ${row.generation}/9007199254740992`));
    await vi.waitFor(() => expect(f.sends).toHaveLength(2));
    expect(allowedCalls().length).toBe(rightsBefore + 1);
    for (const invalid of [
      `${reset} ${row.chatId}`,
      `Начать заново ${row.chatId} 0/0`,
      `Продолжить ${row.chatId} ${row.generation}/-1`,
      `Продолжить vk:9007199254740992 ${row.generation}/0`,
      `Продолжить ${row.chatId}\n${row.generation}/0`,
    ])
      f.update(f.event(invalid));
    await vi.waitFor(() => expect(f.sends).toHaveLength(7));
    expect(
      f.sends
        .slice(1)
        .every(({ peer, text }) => peer === owner && text.startsWith('Скопируйте целую команду')),
    ).toBe(true);
    expect(f.paused()).toEqual(previous);
    expect(f.model).not.toHaveBeenCalled();
    expect(await f.storage.messages.list(ownerScope, { limit: 10 })).toEqual([]);

    f.allowPrivate(false);
    f.update(f.event(overview));
    await vi.waitFor(() => expect(allowedCalls().length).toBe(rightsBefore + 7));
    expect(f.sends).toHaveLength(7);
    f.allowPrivate(true);
    f.update(f.event(overview));
    await vi.waitFor(() => expect(f.sends).toHaveLength(8));
    expect(f.sends[7]).toMatchObject({ peer: owner, text: expect.stringContaining(reset) });
    expect(Buffer.byteLength(f.sends[7]!.text)).toBeLessThanOrEqual(vkMessageLength.value);
    expect(f.paused()).toEqual(previous);
    f.update(f.event(reset));
    await vi.waitFor(() => expect(f.sends).toHaveLength(9));
    expect(f.paused()).toEqual(previous);
    const cancel = f.sends[8]!.text.match(/\/отменить-сброс [a-f\d]+/u)![0];
    f.update(f.event(cancel));
    await vi.waitFor(() => expect(f.sends.at(-1)?.text).toContain('отменён'));
    expect(f.paused()).toEqual(previous);
    f.update(f.event(reset));
    await vi.waitFor(() => expect(f.sends).toHaveLength(11));
    const confirm = f.sends[10]!.text.match(/\/подтвердить-сброс [a-f\d]+/u)![0];
    f.update(
      f.event(confirm, member),
      f.event(confirm, owner, owner, { fwd_messages: [{ text: confirm }] }),
      f.event(confirm),
    );
    await vi.waitFor(() => expect(f.paused()).toEqual([]));
    expect(f.life.current(row.chatId).generation).not.toBe(row.generation);
    await f.life.verify(ownerId, 'observation_lost');
    f.update(f.event('/команды'));
    await vi.waitFor(() => expect(f.sends.at(-1)?.text).toContain('Приостановленные беседы'));
    expect(f.sends.at(-1)?.text).not.toContain('/помощь напоминания');
    f.update(f.event(overview));
    await vi.waitFor(() => expect(f.sends.at(-1)?.text).toContain(`Беседа ${ownerId}`));
    expect(f.sends.at(-1)).toMatchObject({
      peer: owner,
      text: expect.stringContaining(`Беседа ${ownerId}`),
    });
    expect(() => f.life.current(ownerId)).toThrow('uncertain_connection');
  } finally {
    await f.close();
  }
});

test('десять строк обзора приводят к независимым решениям, повтор сброса сохраняет новое поколение', async () => {
  const f = await fixture();
  try {
    await f.start(5);
    const peers = Array.from({ length: 10 }, (_, index) => firstPeer + index);
    const firstScope = f.open(peers[0]!);
    const lastScope = f.open(peers.at(-1)!);
    await f.storage.chats.create(firstScope, {
      createdAt: Date.now(),
      responseMode: 'active',
      enabled: false,
    });
    await f.storage.chats.create(lastScope, {
      createdAt: Date.now(),
      responseMode: 'silent',
      enabled: true,
    });
    await f.record(firstScope, '1');
    const title = 'Книжный клуб';
    f.connection.run((db) =>
      db.prepare('UPDATE chats SET title=? WHERE chat_id=?').run(title, lastScope.chatId),
    );
    await f.record(lastScope, '2');
    for (const peer of peers.slice(1, -1)) {
      const scope = f.open(peer);
      await f.record(scope, '3');
    }
    f.update(
      f.event('', peers[1], member, {
        action: { type: 'chat_invite_user', member_id: -community },
      }),
    );
    await f.life.verify(chat(peers[2]!));
    await f.gap();
    f.connection.run((db) =>
      db
        .prepare('UPDATE chat_connections SET pause_reason=NULL WHERE chat_id=?')
        .run(chat(peers[3]!)),
    );

    const activePeer = firstPeer + peers.length;
    const activeScope = f.open(activePeer);
    const disclosure = disclosureStore(f.storage);
    const disclosed = disclosure.register(
      {
        provider: 'OpenCode Go',
        dataPolicy: 'Синтетические данные',
        storagePolicy: 'Тестовое хранение',
        detailsText: 'Тестовое раскрытие',
        detailsUrl: 'https://example.test/details',
        ownerContact: 'Тестовый контакт',
        change: 'material',
      },
      Date.now(),
    );
    await vi.waitFor(() => expect(disclosure.gate(activeScope).version).toBe(disclosed));

    const pauseSnapshot = f.paused();
    const parts = () => f.sends.filter(({ text }) => text.startsWith(`${overview} VK`));
    f.update(f.event(overview));
    await vi.waitFor(() =>
      expect(parts().flatMap(({ text }) => text.split('\n\n').slice(1))).toHaveLength(10),
    );
    expect(parts().length).toBeGreaterThan(1);
    const blocks = parts().flatMap(({ peer, text }) => {
      expect(peer).toBe(owner);
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(vkMessageLength.value);
      expect(text).not.toContain('Прежняя синтетическая переписка');
      return text
        .split('\n\n')
        .slice(1)
        .map((block) => block.split('\n'));
    });
    expect(pauseSnapshot.map(({ chatId }) => chatId)).toEqual(peers.map(chat));
    expect(blocks[1]![0]).toContain('VK сообщил');
    expect(blocks[2]![0]).toContain('Сверка не подтвердила');
    expect(blocks[3]![0]).toContain('Причина прежней паузы не сохранена');
    expect(blocks[0]![0]).toContain('Прервалось наблюдение за событиями VK');
    for (const [index, lines] of blocks.entries()) {
      const { chatId, generation, revision } = pauseSnapshot[index]!;
      expect(lines).toEqual([
        expect.stringContaining(`Беседа ${chatId}`),
        `Продолжить ${chatId} ${generation}/${revision}`,
        expect.stringContaining('Сохраняет текущую историю'),
        `Начать заново ${chatId} ${generation}/${revision}`,
        expect.stringContaining('Удаляет данные прежнего подключения'),
      ]);
    }
    const before = f.connection.run((db) =>
      db
        .prepare(
          'SELECT chat_id,platform_message_id AS message_id FROM messages WHERE chat_id<>? ORDER BY id',
        )
        .all(activeScope.chatId),
    );
    f.update(...peers.map((peer) => f.event('[club314|Бот] Вопрос на паузе', peer, member)));
    f.update(f.event('[club314|Бот] Вопрос в действующей беседе', activePeer, member));
    await vi.waitFor(async () =>
      expect((await f.storage.traces.last(activeScope))?.payload.publication.status).toBe(
        'delivered',
      ),
    );
    expect(f.model).toHaveBeenCalledOnce();
    expect(
      f.connection.run((db) =>
        db
          .prepare(
            'SELECT chat_id,platform_message_id AS message_id FROM messages WHERE chat_id<>? ORDER BY id',
          )
          .all(activeScope.chatId),
      ),
    ).toEqual(before);

    const continueCommand = blocks[0]![1]!;
    const resetCommand = blocks.at(-1)![3]!;
    f.update(f.event(continueCommand));
    await vi.waitFor(() =>
      expect(f.sends).toContainEqual({
        peer: owner,
        text: expect.stringContaining(`Беседа ${firstScope.chatId} продолжена`),
      }),
    );
    const continued = f.life.current(firstScope.chatId);
    expect(continued.generation).toBe(firstScope.generation);
    expect(await f.storage.messages.list(continued, { limit: 10 })).toMatchObject([
      { messageId: '1' },
    ]);
    expect(await f.storage.chats.get(continued)).toMatchObject({
      enabled: false,
      responseMode: 'active',
    });

    f.failSend((text) => text.startsWith(`Для беседы ${lastScope.chatId} начато`));
    const resetEvent = f.event(resetCommand);
    f.update(resetEvent);
    await vi.waitFor(() => expect(f.sends.at(-1)?.text).toContain('/подтвердить-сброс'));
    const warning = f.sends.at(-1)!.text;
    expect(warning).toContain(title);
    expect(warning).toContain(lastScope.chatId);
    expect(f.paused().some((row) => row.chatId === lastScope.chatId)).toBe(true);
    f.update(f.event(warning.match(/\/подтвердить-сброс [a-f\d]+/u)![0]));
    await vi.waitFor(() => expect(f.failed).toHaveLength(1));
    expect(f.failed[0]).toMatchObject({ peer: owner });
    const reset = f.life.current(lastScope.chatId);
    expect(reset.generation).not.toBe(lastScope.generation);
    expect(await f.storage.messages.list(reset, { limit: 10 })).toEqual([]);
    await vi.waitFor(async () =>
      expect(await f.storage.chats.get(reset)).toMatchObject({
        enabled: true,
        responseMode: 'normal',
      }),
    );
    await f.record(reset, '4');
    f.update(resetEvent);
    const stale = (chatId: ChatId) =>
      f.sends.filter(
        ({ peer, text }) =>
          peer === owner && text.startsWith(`Состояние беседы ${chatId} изменилось.`),
      );
    await vi.waitFor(() => expect(stale(reset.chatId)).toHaveLength(1));
    expect(f.failed).toHaveLength(1);
    expect(f.life.current(reset.chatId).generation).toBe(reset.generation);
    expect(await f.storage.messages.list(reset, { limit: 10 })).toMatchObject([{ messageId: '4' }]);
    expect(f.paused()).toEqual(pauseSnapshot.slice(1, -1));
    expect(f.life.current(activeScope.chatId).generation).toBe(activeScope.generation);

    const initialPartCount = parts().length;
    f.update(f.event(overview));
    await vi.waitFor(() =>
      expect(
        parts()
          .slice(initialPartCount)
          .flatMap(({ text }) => text.split('\n\n').slice(1)),
      ).toHaveLength(8),
    );
    expect(f.paused()).toEqual(pauseSnapshot.slice(1, -1));

    await f.stop();
    const reopened = await openStorage(f.path);
    try {
      const life = createLifecycleService({
        storage: reopened,
        ownerId,
        source: unconfirmedLifecycleSource,
      });
      expect(life.pausedConnections('vk', ownerId)).toEqual(pauseSnapshot.slice(1, -1));
      expect(await reopened.messages.list(life.current(reset.chatId), { limit: 10 })).toMatchObject(
        [{ messageId: '4' }],
      );
    } finally {
      await reopened.close();
    }
    await f.start();
    const restarted = f.paused();
    expect(restarted).toHaveLength(11);
    expect(restarted.find(({ chatId }) => chatId === continued.chatId)).toMatchObject({
      generation: continued.generation,
      revision: pauseSnapshot[0]!.revision + 2,
      reason: 'startup',
    });
    expect(restarted.find(({ chatId }) => chatId === reset.chatId)).toMatchObject({
      generation: reset.generation,
      reason: 'startup',
    });
    expect(restarted.filter(({ reason }) => reason === 'startup')).toHaveLength(3);
    f.update(f.event(continueCommand), f.event(resetCommand));
    await vi.waitFor(() => {
      expect(stale(continued.chatId)).toHaveLength(1);
      expect(stale(reset.chatId)).toHaveLength(2);
    });
    expect(f.paused()).toEqual(restarted);
    expect(
      f.connection.run((db) =>
        db
          .prepare('SELECT platform_message_id AS message_id FROM messages WHERE chat_id=?')
          .all(reset.chatId),
      ),
    ).toEqual([{ message_id: '4' }]);
    expect(f.model).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});
