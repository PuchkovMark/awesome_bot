import { describe, expect, it, vi } from 'vitest';
import { createVkChannel } from '../src/channels/index';
import { createVkApi, createVkApiCall } from '../src/channels/vk/api';
import type { VkApiCall } from '../src/channels/vk/api';
import type { VkPollTransport } from '../src/channels/vk/long-poll';
import { createVkRateLimiter } from '../src/channels/vk/rate-limit';
import type { ChatId } from '../src/contracts/index';
import { createAgentLoopQueue, createLifecycleService, createMessageRouter, createPublicationService } from '../src/core/index';
import { openStorage } from '../src/storage/index';
import { flushQueue } from './helpers/chat-queue';

const groupId = 314;
const owner = 'vk:73';
const peer = 2_000_000_004;
const other = peer + 1;
const chat: ChatId = `vk:${peer}`;
const otherChat: ChatId = `vk:${other}`;
const date = 1_700_000_000;
const longAnswer = '🙂'.repeat(1100);
const usage = { input: 0, output: 0 };

function transportFixture() {
  let listener: Parameters<VkPollTransport['run']>[0];
  const ready = Promise.withResolvers<void>();
  const transport: VkPollTransport = {
    async run(current, signal) {
      listener = current;
      await listener.onGap('startup');
      ready.resolve();
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    },
  };
  return { transport, ready: ready.promise, update(events: readonly unknown[]) { listener.onUpdates(events); } };
}

async function fixture(options: {
  readonly sendError?: number;
  readonly replyUnavailable?: boolean;
  readonly empty?: boolean;
  readonly onWaitAfterFirst?: () => Promise<void>;
  readonly beforeFirstConfirmation?: () => Promise<void>;
  readonly retryWait?: () => Promise<void>;
  readonly beforeModel?: () => Promise<void>;
} = {}) {
  const storage = await openStorage(':memory:');
  const life = createLifecycleService({
    storage, ownerId: owner, source: { async observe() { return { confidence: 'confirmed', bot: 'present' }; } },
  });
  await life.verify(chat);
  await life.verify(otherChat);
  const controller = new AbortController();
  const { transport, ready, update } = transportFixture();
  const rows = new Map<number, Map<number, Record<string, unknown>>>();
  let sent = 0;
  let now = 0;
  let blockNext = false;
  const startedAt: number[] = [];
  const factory = createVkRateLimiter({
    now: () => now,
    async wait(ms) {
      now += ms;
      if (blockNext && options.onWaitAfterFirst) {
        blockNext = false;
        await options.onWaitAfterFirst();
      }
    },
  });
  const attempt = vi.fn(async (method: Parameters<VkApiCall>[0], args: Parameters<VkApiCall>[1]) => {
    startedAt.push(now);
    if (method === 'users.get') return { response: [{ id: 73, first_name: 'Тест', last_name: '' }] };
    if (method === 'messages.getConversationMembers') return { response: { items: [] } };
    if (method === 'messages.setActivity') return { error: { error_code: 10, error_msg: 'private' } };
    if (method === 'messages.getConversationsById') return { response: { items: [{
      peer: { id: Number(args.peer_ids) }, can_write: { allowed: true }, chat_settings: { state: 'in' },
    }] } };
    const target = Number(args.peer_ids ?? args.peer_id);
    const list = rows.get(target)!;
    if (method === 'messages.getByConversationMessageId') {
      const id = Number(args.conversation_message_ids);
      if (options.replyUnavailable && id === 7) return { error: { error_code: 917 } };
      if (id === 8 && target === peer) {
        blockNext = true;
        await options.beforeFirstConfirmation?.();
      }
      return { response: { items: [list.get(id)].filter(Boolean) } };
    }
    if (method !== 'messages.send') throw new Error('Unexpected virtual VK request');
    sent++;
    if (sent > 1 && options.sendError) return { error: { error_code: options.sendError, error_msg: 'private' } };
    const id = Math.max(...list.keys()) + 1;
    list.set(id, {
      peer_id: target, conversation_message_id: id, from_id: -groupId, date: date + id, text: args.message,
      ...(args.forward ? { reply_message: list.get(7) } : {}),
    });
    return { response: [{ peer_id: target, conversation_message_id: id, message_id: 0 }] };
  });
  const api = createVkApi(groupId, createVkApiCall(attempt, factory));
  const channel = createVkChannel({
    groupId, token: 'synthetic', signal: controller.signal, lifecycle: life, chats: storage.chats,
  }, { api, transport, wait: options.retryWait ?? (async () => undefined) });
  const publication = createPublicationService({ storage, port: channel.publicationPort });
  const queue = createAgentLoopQueue({
    storage, tracing: { messageRetentionDays: 30 }, modelName: 'synthetic-model',
    prepare: async () => ({ kind: 'ready', input: {
      system: '', messages: [{ role: 'user', text: 'Тестовый вопрос' }], maxOutputTokens: 500, sessionId: 'synthetic',
    } }),
    client: { async complete() {
      await options.beforeModel?.();
      return options.empty ? { kind: 'empty', usage } : { kind: 'complete', text: longAnswer, usage };
    } },
    onSettled: publication.onSettled,
  });
  const router = createMessageRouter({ storage, queue, onQueueFull: publication.queueFull });
  const pending = channel.startRouted(router);
  await ready;
  const decide = (target: ChatId, policy: 'continue' | 'new' = 'continue') => life.decide(life.owner(target, owner), policy);
  const scopes = [decide(chat), decide(otherChat)] as const;
  await queue.start();

  return {
    channel, storage, life, publication, scopes, startedAt, decide,
    submit(...peers: number[]) {
      update(peers.map(target => {
        const message = { peer_id: target, from_id: 73, conversation_message_id: 7, out: 0, date, text: '[club314|Бот] Тест' };
        rows.set(target, new Map([[7, message]]));
        return { type: 'message_new', group_id: groupId, object: { message } };
      }));
    },
    membership(memberId: number, type = 'chat_invite_user') {
      update([{
        type: 'message_new', group_id: groupId,
        object: { message: { peer_id: peer, from_id: 73, conversation_message_id: 100, date,
          action: { type, member_id: memberId },
        } },
      }]);
    },
    sends: () => attempt.mock.calls.filter(([method]) => method === 'messages.send'),
    async close() {
      controller.abort();
      try { await pending; } finally { await queue.stop(); await storage.close(); }
    },
  };
}

describe('публикация VK через очередь и журнал', () => {
  it('проводит два чата с одинаковым ID источника через штатный роутер и общий лимитер', async () => {
    const f = await fixture();
    try {
      await f.storage.chats.create(f.scopes[0], { enabled: true, responseMode: 'normal', createdAt: 0 });
      expect((await f.channel.capabilities({ chatId: chat })).support).toMatchObject({ send: 'supported', typing: 'unknown' });
      await f.channel.sendTyping(chat);
      expect(f.channel.stats().typingFailed).toBe(1);
      f.submit(peer, other);
      for (const scope of f.scopes) {
        const confirm = await vi.waitFor(async () => {
          const log = await f.storage.messages.list(scope, { limit: 10 });
          expect(log).toHaveLength(3);
          return log.filter(row => row.role === 'assistant');
        });
        expect(confirm.map(row => row.text).join('')).toBe(longAnswer);
        expect(confirm.map(row => row.chatId)).toEqual([scope.chatId, scope.chatId]);
        expect(confirm[0]).toMatchObject({ messageId: '8', replyToMessageId: '7', timestamp: (date + 8) * 1000 });
        expect(confirm[1]).not.toHaveProperty('replyToMessageId');
      }
      expect(f.sends()).toHaveLength(4);
      expect(f.startedAt.every((time, i, times) => i === 0 || time - times[i - 1]! >= 50)).toBe(true);
    } finally { await f.close(); }
  });

  it('подтверждает возможность служебных событий после наблюдения в той же области', async () => {
    const f = await fixture();
    try {
      await f.storage.chats.create(f.scopes[0], { enabled: false, responseMode: 'normal', createdAt: 0 });
      expect((await f.channel.capabilities({ chatId: chat })).support.membershipEvents).toBe('unknown');
      f.membership(84);
      expect((await f.channel.capabilities({ chatId: chat })).support).toMatchObject({
        membershipEvents: 'supported', send: 'unknown',
      });
      expect((await f.channel.capabilities({ chatId: otherChat })).support.membershipEvents).toBe('unknown');
      expect((await f.channel.capabilities({ chatId: 'vk:73' })).support.membershipEvents).toBe('unsupported');
      await f.life.verify(chat, 'observation_lost');
      f.decide(chat);
      expect((await f.channel.capabilities({ chatId: chat })).support.membershipEvents).toBe('unknown');
    } finally { await f.close(); }
  });

  it('оставляет в журнале только подтверждённую часть после неизвестного исхода', async () => {
    const f = await fixture({ sendError: 10 });
    try {
      f.submit(peer);
      await vi.waitFor(() => expect(f.publication.stats().partial_delivery).toBe(1));
      const rows = await f.storage.messages.list(f.scopes[0], { limit: 10 });
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({ messageId: '8', text: '🙂'.repeat(1000), role: 'assistant' });
      expect(f.sends()).toHaveLength(2);
      const trace = await f.storage.traces.get(f.scopes[0], 1);
      expect(trace?.payload.publication).toMatchObject({ status: 'unknown', reason: 'partial_delivery' });
    } finally { await f.close(); }
  });

  it('быстрое выключение и включение останавливает старую часть в лимитере VK', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const f = await fixture({ onWaitAfterFirst() { entered.resolve(); return release.promise; } });
    try {
      const scope = f.scopes[0];
      f.submit(peer);
      await entered.promise;
      await f.storage.chats.update(scope, { enabled: false });
      await f.storage.chats.update(scope, { enabled: true });
      release.resolve();
      await vi.waitFor(async () => expect((await f.storage.traces.get(scope, 1))?.payload.publication)
        .toMatchObject({ status: 'failed', reason: 'partial_delivery' }));
      expect(f.sends()).toHaveLength(1);
      expect((await f.storage.messages.list(scope, { limit: 10 })).map(row => row.messageId)).toEqual(['7', '8']);
    } finally { release.resolve(); await f.close(); }
  });

  it('останавливает остальные части, если подтверждённую запись нельзя сохранить', async () => {
    const f = await fixture();
    try {
      await f.storage.messages.append(f.scopes[0], {
        chatId: chat, messageId: '8', userId: 'vk:-314', authorName: '', timestamp: 0, role: 'assistant', text: 'Другая запись',
      });
      f.submit(peer);
      await vi.waitFor(() => expect(f.publication.stats().journal_failed).toBe(1));
      const rows = await f.storage.messages.list(f.scopes[0], { limit: 10 });
      expect(rows).toHaveLength(2);
      expect(rows.find(row => row.messageId === '8')?.text).toBe('Другая запись');
      expect(f.sends()).toHaveLength(1);
      expect((await f.storage.traces.get(f.scopes[0], 1))?.payload.publication)
        .toMatchObject({ status: 'unknown', reason: 'journal_failed' });
    } finally { await f.close(); }
  });

  it.each(['continue', 'new'] as const)('останавливается в лимитере при сигнале VK и решении %s во время отправки', async policy => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const f = await fixture({ onWaitAfterFirst() { entered.resolve(); return release.promise; } });
    try {
      f.submit(peer);
      await entered.promise;
      expect((await f.storage.messages.list(f.scopes[0], { limit: 10 })).map(row => row.messageId)).toEqual(['7', '8']);
      f.membership(-groupId, 'chat_kick_user');
      expect(() => f.life.current(chat)).toThrow('uncertain_connection');
      const latest = f.decide(chat, policy);
      release.resolve();
      await vi.waitFor(() => expect(f.publication.stats().partial_delivery).toBe(1));
      expect(f.sends()).toHaveLength(1);
      expect((await f.storage.messages.list(latest, { limit: 10 })).map(row => row.messageId))
        .toEqual(policy === 'continue' ? ['7', '8'] : []);
    } finally { release.resolve(); await f.close(); }
  });

  it('при выключении во время паузы перед повтором прекращает отправку', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const f = await fixture({ sendError: 6, retryWait() { entered.resolve(); return release.promise; } });
    try {
      f.submit(peer);
      await entered.promise;
      await f.storage.chats.update(f.scopes[0], { enabled: false });
      release.resolve();
      await vi.waitFor(() => expect(f.publication.stats().partial_delivery).toBe(1));
      expect(f.sends()).toHaveLength(2);
      expect(await f.storage.messages.list(f.scopes[0], { limit: 10 })).toHaveLength(2);
    } finally { release.resolve(); await f.close(); }
  });

  it('не пишет часть, подтверждение которой пришло после паузы и продолжения', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const f = await fixture({ beforeFirstConfirmation() { entered.resolve(); return release.promise; } });
    try {
      f.submit(peer);
      await entered.promise;
      await f.life.verify(chat, 'observation_lost');
      const current = f.decide(chat);
      release.resolve();
      await vi.waitFor(() => expect(f.publication.stats().publication_failed).toBe(1));
      expect(f.sends()).toHaveLength(1);
      expect((await f.storage.messages.list(current, { limit: 10 })).map(row => row.messageId)).toEqual(['7']);
    } finally { release.resolve(); await f.close(); }
  });

  it('отклоняет исход старой работы, если владелец продолжил то же поколение до публикации', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const f = await fixture({ beforeModel() { entered.resolve(); return release.promise; } });
    try {
      f.submit(peer);
      await entered.promise;
      await f.life.verify(chat, 'observation_lost');
      const current = f.decide(chat, 'continue');
      release.resolve();
      await vi.waitFor(async () => expect(await f.storage.queue.get(current, 1)).toMatchObject({ outcome: 'interrupted' }));
      expect(f.sends()).toHaveLength(0);
      expect(await f.storage.messages.list(current, { limit: 10 })).toHaveLength(1);
    } finally { release.resolve(); await f.close(); }
  });

  it.each([false, true])('служебное уведомление остаётся ответом и скрывается от контекста, недоступность reply %s', async replyUnavailable => {
    const f = await fixture({ empty: true, replyUnavailable });
    try {
      f.submit(peer);
      await vi.waitFor(async () => {
        const trace = await f.storage.traces.get(f.scopes[0], 1);
        expect(trace?.payload.publication.status).toBe(replyUnavailable ? 'suppressed' : 'delivered');
      });
      expect(f.sends()).toHaveLength(replyUnavailable ? 0 : 1);
      const log = await f.storage.messages.list(f.scopes[0], { limit: 10 });
      expect(log).toHaveLength(replyUnavailable ? 1 : 2);
      if (!replyUnavailable) expect(log[1]).toMatchObject({ replyToMessageId: '7', purpose: 'service_notice' });
      expect(await f.storage.contextMessages.list(f.scopes[0], { limit: 10 })).toHaveLength(1);
      await flushQueue();
    } finally { await f.close(); }
  });
});
