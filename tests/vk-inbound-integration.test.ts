import { describe, expect, it, vi } from 'vitest';
import { createVkInbound } from '../src/channels/index';
import type { VkInboundApi } from '../src/channels/vk/api';
import type { VkPollTransport } from '../src/channels/vk/long-poll';
import { createChatQueue, createLifecycleService, createMessageRouter } from '../src/core/index';
import type { ChatId, ConnectionScope, MembershipEvent } from '../src/contracts/index';
import { openStorage } from '../src/storage/index';
import type { Storage } from '../src/storage/index';
import { flushQueue } from './helpers/chat-queue';

const groupId = 314;
const firstPeer = 2_000_000_004;
const secondPeer = 2_000_000_005;
const firstChat: ChatId = `vk:${firstPeer}`;
const secondChat: ChatId = `vk:${secondPeer}`;
const owner = 'vk:73';

function event(cmid: number, message: Record<string, unknown> = {}) {
  return {
    type: 'message_new',
    group_id: groupId,
    object: {
      message: {
        peer_id: firstPeer,
        from_id: 73,
        conversation_message_id: cmid,
        date: 1_700_000_000 + cmid,
        out: 0,
        text: '[club314|Бот] Привет 🌿',
        ...message,
      },
    },
  };
}

function transportFixture() {
  const ready = Promise.withResolvers<void>();
  let listener: Parameters<VkPollTransport['run']>[0];
  const transport: VkPollTransport = {
    async run(current, signal) {
      listener = current;
      await listener.onGap('startup');
      ready.resolve();
      if (!signal.aborted)
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
    },
  };
  return {
    transport,
    ready: ready.promise,
    update(...updates: unknown[]) {
      listener.onUpdates(updates);
    },
    gap() {
      return listener.onGap('lost_position');
    },
  };
}

async function fixture() {
  const storage = await openStorage(':memory:');
  const lifecycle = createLifecycleService({
    storage,
    ownerId: owner,
    source: {
      async observe() {
        return { confidence: 'confirmed', bot: 'present' };
      },
    },
  });
  const { transport, update, gap, ready } = transportFixture();
  const controller = new AbortController();
  const api: VkInboundApi = {
    // Подмена транспорта работает без сервера VK.
    async getLongPollServer() {
      throw new Error('Unexpected network');
    },
    async enrich(message) {
      return message.authorId === 73
        ? {
            authorName: 'Тест',
            isBot: false,
            ...(message.reply ? { verifiedReply: message.reply } : {}),
          }
        : {};
    },
  };
  const handled = vi.fn(async (scope: ConnectionScope, id: number) => {
    const message = await storage.messages.get(scope, id);
    const reply = message?.replyToMessageId
      ? await storage.contextMessages.reply(scope, message.replyToMessageId, id, 100)
      : null;
    return { message, reply };
  });
  const queue = createChatQueue({
    storage,
    tracing: { messageRetentionDays: 30 },
    async handler({ scope, messageId }) {
      await handled(scope, messageId);
      return 'completed';
    },
  });
  await queue.start();
  const decide = (chat: ChatId, policy: 'continue' | 'new' = 'continue') =>
    lifecycle.decide(lifecycle.owner(chat, owner), policy);
  return {
    storage,
    lifecycle,
    transport,
    update,
    gap,
    ready,
    controller,
    api,
    queue,
    handled,
    decide,
  };
}

function start(
  f: Awaited<ReturnType<typeof fixture>>,
  options: {
    readonly storage?: Storage;
    readonly api?: VkInboundApi;
    readonly membership?: (event: MembershipEvent) => Promise<void>;
  } = {},
) {
  const onDecision = vi.fn();
  const verify = vi.fn(f.lifecycle.verify);
  const router = createMessageRouter({
    storage: options.storage ?? f.storage,
    queue: f.queue,
    onDecision,
  });
  const inbound = createVkInbound(
    {
      groupId,
      token: 'synthetic-token',
      signal: f.controller.signal,
      lifecycle: { ...f.lifecycle, verify },
    },
    { api: options.api ?? f.api, transport: f.transport },
  );
  return { inbound, onDecision, verify, done: inbound.startRouted(router, options.membership) };
}

async function close(f: Awaited<ReturnType<typeof fixture>>, done: Promise<void>) {
  f.controller.abort();
  try {
    await done;
  } finally {
    await f.queue.stop();
    await f.storage.close();
  }
}

describe('приём VK через штатный роутер', () => {
  it('журналирует до обработки, разрешает reply из этой беседы и дедуплицирует в пределах peer', async () => {
    const f = await fixture();
    const old = (await f.lifecycle.verify(firstChat)).scope!;
    const synthetic = (await f.lifecycle.verify('other:1')).scope!;
    const run = start(f);
    try {
      await f.ready;
      expect(() => f.lifecycle.current(firstChat)).toThrow('uncertain_connection');
      expect(f.lifecycle.current('other:1').generation).toBe(synthetic.generation);
      f.update(event(1), event(1, { peer_id: secondPeer }));
      await flushQueue();
      expect(f.handled).not.toHaveBeenCalled();
      expect(() => f.lifecycle.current(secondChat)).toThrow('uncertain_connection');
      expect(run.verify.mock.calls).toEqual([
        [firstChat, 'startup'],
        [secondChat, 'first_seen'],
      ]);

      const first = f.decide(firstChat);
      const second = f.decide(secondChat);
      expect(first.generation).toBe(old.generation);
      f.update(
        event(1),
        event(1),
        event(1, { peer_id: secondPeer }),
        event(2, {
          text: 'ответ',
          reply_message: { peer_id: firstPeer, from_id: 73, conversation_message_id: 1 },
        }),
        event(3, { from_id: 99 }),
      );
      await vi.waitFor(() => expect(run.onDecision).toHaveBeenCalledTimes(4));
      const stored = await f.storage.messages.list(first, { limit: 10 });
      expect(stored.map((row) => row.messageId).sort()).toEqual(['1', '2', '3']);
      expect(await f.storage.messages.list(second, { limit: 10 })).toMatchObject([
        { messageId: '1', chatId: secondChat },
      ]);
      expect(stored.find((row) => row.messageId === '2')?.replyToMessageId).toBe('1');
      const reply = stored.find((row) => row.messageId === '2')!;
      expect(await f.storage.contextMessages.reply(first, '1', reply.id, 100)).toMatchObject({
        messageId: '1',
        chatId: firstChat,
        text: 'Привет 🌿',
      });
      expect(run.onDecision).toHaveBeenCalledWith({ kind: 'silence', reason: 'sender_unknown' });
      await vi.waitFor(() => expect(f.handled).toHaveBeenCalledTimes(2));
      expect(await Promise.all(f.handled.mock.results.map((result) => result.value))).toEqual(
        expect.arrayContaining([
          { message: expect.objectContaining({ messageId: '1', chatId: firstChat }), reply: null },
          { message: expect.objectContaining({ messageId: '1', chatId: secondChat }), reply: null },
        ]),
      );
      await f.storage.chats.update(first, { enabled: false });
      f.update(event(4));
      await flushQueue();
      expect(await f.storage.messages.list(first, { limit: 10 })).toHaveLength(3);
    } finally {
      await close(f, run.done);
    }
  });

  it.each(['continue', 'new'] as const)(
    'не допускает старое обогащение после решения %s',
    async (policy) => {
      const f = await fixture();
      const requested = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const run = start(f, {
        api: {
          ...f.api,
          async enrich(message) {
            if (message.cmid === 2) {
              requested.resolve();
              await release.promise;
            }
            return f.api.enrich(message);
          },
        },
      });
      try {
        await f.ready;
        f.update(event(1));
        const first = f.decide(firstChat);
        f.update(event(2));
        await requested.promise;
        await f.gap();
        expect(run.verify).toHaveBeenLastCalledWith(firstChat, 'observation_lost');
        expect(() => f.lifecycle.current(firstChat)).toThrow('uncertain_connection');
        f.update(event(3));
        const next = f.decide(firstChat, policy);
        if (policy === 'continue') expect(next.generation).toBe(first.generation);
        else expect(next.generation).not.toBe(first.generation);
        f.update(event(4));
        await vi.waitFor(() => expect(run.onDecision).toHaveBeenCalledOnce());
        release.resolve();
        await flushQueue();
        expect(await f.storage.messages.list(next, { limit: 10 })).toMatchObject([
          { messageId: '4' },
        ]);
        expect(run.inbound.stats()).toMatchObject({
          paused: 3,
          dispatched: 1,
          failed: 0,
          gaps: { lost_position: 1 },
        });
      } finally {
        release.resolve();
        await close(f, run.done);
      }
    },
  );

  it('повторяет проверку внутри receive при паузе между получением настроек и записью', async () => {
    const f = await fixture();
    const reading = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const storage = {
      ...f.storage,
      chats: {
        ...f.storage.chats,
        async create(scope: ConnectionScope, input: Parameters<Storage['chats']['create']>[1]) {
          const result = await f.storage.chats.create(scope, input);
          reading.resolve();
          await release.promise;
          return result;
        },
      },
    };
    const run = start(f, { storage });
    try {
      await f.ready;
      f.update(event(1));
      f.decide(firstChat);
      const oldAdmission = f.lifecycle.admissionScope(firstChat);
      f.update(event(2));
      await reading.promise;
      await f.gap();
      const scope = f.decide(firstChat);
      expect(oldAdmission.generation).toBe(scope.generation);
      await expect(f.storage.chats.get(oldAdmission)).rejects.toMatchObject({
        code: 'stale_scope',
      });
      release.resolve();
      await flushQueue();
      expect(await f.storage.messages.list(scope, { limit: 10 })).toHaveLength(0);
      expect(run.onDecision).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await close(f, run.done);
    }
  });

  it('передаёт подтверждённую личку штатному EventHandler', async () => {
    const f = await fixture();
    const handler = vi.fn(async () => undefined);
    const inbound = createVkInbound(
      { groupId, token: 'synthetic-token', signal: f.controller.signal, lifecycle: f.lifecycle },
      { api: f.api, transport: f.transport },
    );
    const done = inbound.start(handler);
    try {
      await f.ready;
      f.update(event(1, { peer_id: 73 }));
      f.decide('vk:73');
      f.update(event(2, { peer_id: 73, text: 'Личное сообщение' }));
      await vi.waitFor(() =>
        expect(handler).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            chatId: 'vk:73',
            messageId: '2',
            isGroupChat: false,
            text: 'Личное сообщение',
            isBot: false,
          }),
        ),
      );
    } finally {
      await close(f, done);
    }
  });

  it('приостанавливает приём при приглашении сообщества только в затронутой беседе', async () => {
    const f = await fixture();
    const membership = vi.fn(async () => undefined);
    const run = start(f, { membership });
    try {
      await f.ready;
      f.update(event(1), event(1, { peer_id: secondPeer }));
      f.decide(firstChat);
      const second = f.decide(secondChat);
      f.update(
        event(2, { action: { type: 'chat_invite_user', member_id: -groupId } }),
        event(3),
        event(3, { peer_id: secondPeer }),
      );
      expect(() => f.lifecycle.current(firstChat)).toThrow('uncertain_connection');
      await vi.waitFor(() => expect(run.onDecision).toHaveBeenCalledOnce());
      expect(await f.storage.messages.list(second, { limit: 10 })).toMatchObject([
        { messageId: '3' },
      ]);
      const continued = f.decide(firstChat);
      expect(await f.storage.messages.list(continued, { limit: 10 })).toHaveLength(0);
      expect(membership).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'membership',
          chatId: firstChat,
          eventId: '2',
          subjectId: `vk:${-groupId}`,
          change: 'invited',
        }),
      );
      f.update(event(2, { action: { type: 'chat_invite_user', member_id: -groupId } }), event(4));
      await vi.waitFor(() => expect(run.onDecision).toHaveBeenCalledTimes(2));
      expect(await f.storage.messages.list(continued, { limit: 10 })).toMatchObject([
        { messageId: '4' },
      ]);
      expect(run.inbound.stats()).toMatchObject({
        connectionChanges: 2,
        duplicateSignals: 1,
        failed: 0,
      });
    } finally {
      await close(f, run.done);
    }
  });

  it('передаёт события людей отдельному обработчику при выключенном боте без журнала и заданий', async () => {
    const f = await fixture();
    const membership = vi
      .fn<(event: MembershipEvent) => Promise<void>>()
      .mockResolvedValue(undefined);
    const run = start(f, { membership });
    try {
      await f.ready;
      f.update(event(1));
      const scope = f.decide(firstChat);
      await f.storage.chats.create(scope, { responseMode: 'normal', enabled: false, createdAt: 0 });
      const actions = [
        event(2, { action: { type: 'chat_invite_user', member_id: 84 } }),
        event(3, { from_id: 84, action: { type: 'chat_invite_user_by_link', member_id: 84 } }),
        event(4, { from_id: 84, action: { type: 'chat_kick_user', member_id: 84 } }),
        event(5, { action: { type: 'chat_kick_user', member_id: 84 } }),
        event(6, {
          from_id: undefined,
          conversation_message_id: undefined,
          action: { type: 'chat_kick_user' },
        }),
      ];
      f.update(...actions);
      await flushQueue();
      expect(membership.mock.calls.map((call) => call[0])).toMatchObject([
        { change: 'invited', actorId: owner, subjectId: 'vk:84' },
        { change: 'joined', actorId: 'vk:84', subjectId: 'vk:84' },
        { change: 'left', actorId: 'vk:84', subjectId: 'vk:84' },
        { change: 'removed', actorId: owner, subjectId: 'vk:84' },
        { change: 'unknown', actorId: null, subjectId: null },
      ]);
      expect(membership.mock.calls[4]?.[0]).not.toHaveProperty('eventId');
      expect(await f.storage.messages.list(scope, { limit: 10 })).toEqual([]);
      expect(run.onDecision).not.toHaveBeenCalled();
      expect(f.handled).not.toHaveBeenCalled();
      expect(run.inbound.hasMembershipObservation(firstChat)).toBe(true);
      expect(run.inbound.hasMembershipObservation(secondChat)).toBe(false);
      await f.gap();
      expect(run.inbound.hasMembershipObservation(firstChat)).toBe(false);
    } finally {
      await close(f, run.done);
    }
  });

  it('сигнал исключения отзывает ревизию уже начатого обогащения даже после продолжения', async () => {
    const f = await fixture();
    const requested = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const run = start(f, {
      api: {
        ...f.api,
        async enrich(message) {
          if (message.cmid === 2) {
            requested.resolve();
            await release.promise;
          }
          return f.api.enrich(message);
        },
      },
    });
    try {
      await f.ready;
      f.update(event(1));
      const original = f.decide(firstChat);
      f.update(event(2));
      await requested.promise;
      f.update(event(3, { action: { type: 'chat_kick_user', member_id: -groupId } }));
      const continued = f.decide(firstChat);
      expect(continued.generation).toBe(original.generation);
      f.update(event(4));
      release.resolve();
      await vi.waitFor(() => expect(run.onDecision).toHaveBeenCalledOnce());
      expect(await f.storage.messages.list(continued, { limit: 10 })).toMatchObject([
        { messageId: '4' },
      ]);
    } finally {
      release.resolve();
      await close(f, run.done);
    }
  });

  it('публичный обработчик получает наблюдение об участии наряду с сообщениями', async () => {
    const f = await fixture();
    const handler = vi.fn(async () => undefined);
    const inbound = createVkInbound(
      {
        groupId,
        token: 'synthetic-token',
        signal: f.controller.signal,
        lifecycle: f.lifecycle,
      },
      { api: f.api, transport: f.transport },
    );
    const done = inbound.start(handler);
    try {
      await f.ready;
      f.update(event(1));
      f.decide(firstChat);
      f.update(event(2, { action: { type: 'chat_invite_user', member_id: 84 } }), event(3));
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
      expect(handler).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ kind: 'membership', change: 'invited' }),
      );
      expect(handler).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ kind: 'message', messageId: '3' }),
      );
    } finally {
      await close(f, done);
    }
  });
});
