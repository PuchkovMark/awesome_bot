import { describe, expect, it, vi } from 'vitest';
import { createVkApi } from '../src/channels/vk/api';
import type { VkApiCall } from '../src/channels/vk/api';
import { createVkLongPoll } from '../src/channels/vk/long-poll';
import type { VkPollGap } from '../src/channels/vk/long-poll';
import type { VkIncoming } from '../src/channels/vk/normalize';

const groupId = 314;
const peerId = 2_000_000_004;
const server = { server: 'https://lp.vk.ru/poll', key: 'synthetic-key', ts: '10' };

describe('Bots Long Poll', () => {
  function simulate(pages: unknown[], stopAfter: number) {
    const abort = new AbortController();
    const received: unknown[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
      if (pages.length === 0) throw new Error('No more test pages');
      const next = pages.shift();
      return next instanceof Response ? next : Response.json(next);
    });
    const api = { getLongPollServer: vi.fn(async () => server) };
    const wait = vi.fn(async () => {
      if (pages.length === 0) abort.abort();
    });
    const transport = createVkLongPoll({ api, fetch, wait });
    const done = transport.run({
      async onGap(reason: VkPollGap) { received.push(reason); },
      onUpdates(updates) {
        received.push(...updates);
        if (received.filter(x => typeof x === 'object').length >= stopAfter) abort.abort();
      },
    }, abort.signal);
    return { fetch, api, wait, received, done };
  }

  it('продвигает позиции и запрашивает новый сервер после истечения ключа', async () => {
    const first = { message: 1 };
    const second = { message: 2 };
    const run = simulate([{ ts: '11', updates: [first] }, { failed: 2 }, { ts: '20', updates: [second] }], 2);
    await run.done;
    expect(run.received).toEqual(['startup', first, 'renew_server', second]);
    expect(run.api.getLongPollServer).toHaveBeenCalledTimes(2);
    expect(run.fetch.mock.calls.map(([url]) => (url as URL).searchParams.get('ts'))).toEqual(['10', '11', '10']);
    expect(run.fetch.mock.calls[0]?.[1]?.redirect).toBe('error');
  });

  it('сообщает о потере позиции до первой пачки по новой позиции', async () => {
    const event = {
      type: 'message_new', group_id: groupId, event_id: 'synthetic',
      object: { message: { peer_id: peerId, from_id: 73, date: 1_700_000_000,
        conversation_message_id: 8, action: { type: 'chat_invite_user', member_id: -groupId },
      } },
    };
    const run = simulate([{ failed: 1, ts: '55' }, { ts: '56', updates: [event] }], 1);
    await run.done;
    expect(run.received).toEqual(['startup', 'lost_position', event]);
    expect(run.fetch.mock.calls.map(([url]) => (url as URL).searchParams.get('ts'))).toEqual(['10', '55']);
  });

  it('отделяет невалидную пачку и отказ доступа от событий', async () => {
    const run = simulate([{ ts: '11', updates: 'private' }, new Response('private', { status: 403 })], 1);
    await expect(run.done).rejects.toMatchObject({ code: 'access_denied', message: 'VK Long Poll: access_denied' });
    expect(run.received).toEqual(['startup', 'invalid_response', 'transport_error']);
    expect(run.wait).toHaveBeenCalledTimes(1);
  });

  it('защищает URL опроса и сообщает безопасный код VK API', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const listener = { onGap: vi.fn(async () => undefined), onUpdates: vi.fn() };
    const signal = new AbortController().signal;

    const invalidHost = createVkLongPoll({
      api: { getLongPollServer: async () => ({ ...server, server: 'https://vk.ru.example.invalid/secret' }) }, fetch,
    });
    await expect(invalidHost.run(listener, signal)).rejects.toMatchObject({ code: 'unsafe_server' });

    const api = createVkApi(groupId, async () => { throw Object.assign(new Error('synthetic-key'), { code: 5 }); });
    await expect(createVkLongPoll({ api, fetch }).run(listener, signal))
      .rejects.toMatchObject({ code: 'access_denied', vkCode: 5, message: 'VK Long Poll: access_denied' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('подтверждает готовность только на корректной странице и сохраняет её события', async () => {
    const controller = new AbortController();
    const events: string[] = [];
    const serverRequest = vi.fn(async () => server);
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ failed: 1, ts: '50' }))
      .mockResolvedValueOnce(Response.json({ ts: '51', updates: [{ sample: true }] }));
    await createVkLongPoll({ fetch, api: { getLongPollServer: serverRequest } }).run({
      async onGap(reason) { events.push(reason); },
      onReady() { events.push('ready'); },
      onUpdates(updates) {
        expect(updates).toEqual([{ sample: true }]);
        events.push('updates');
        controller.abort();
      },
    }, controller.signal);
    expect(events).toEqual(['startup', 'lost_position', 'ready', 'updates']);
    expect(serverRequest).toHaveBeenCalledWith(controller.signal);
  });
});

describe('VK API на входной границе', () => {
  const incoming: VkIncoming = {
    peerId, authorId: 73, cmid: 8, timestamp: 1_700_000_000_000, text: 'ответ', isMentioned: false,
    attachments: [], reply: undefined,
  };

  it('объединяет профили в пакет и принимает только совпадающие личные ID', async () => {
    const call = vi.fn<VkApiCall>(async (method) => {
      if (method === 'users.get') return [
        { id: 73, first_name: 'Елена', last_name: 'Ли' },
        { id: 75, first_name: 'Скрытый', deactivated: 'deleted' },
      ];
      return { items: [{ member_id: 73, is_admin: true }, { member_id: 74 }] };
    });
    const api = createVkApi(groupId, call);
    const [known, missing, deleted] = await Promise.all([
      api.enrich(incoming), api.enrich({ ...incoming, authorId: 74 }), api.enrich({ ...incoming, authorId: 75 }),
    ]);
    expect(known).toEqual({ authorName: 'Елена Ли', isBot: false, isAdmin: true });
    expect(missing).toEqual({ isBot: 'unknown', isAdmin: 'unknown' });
    expect(deleted).toEqual({ isBot: 'unknown', isAdmin: 'unknown' });
    await api.enrich(incoming);
    expect(call.mock.calls.filter(([method]) => method === 'users.get'))
      .toEqual([['users.get', { user_ids: '73,74,75' }]]);
  });

  it('подтверждает reply в области сообщения и отбрасывает родителя из другой беседы', async () => {
    const message: VkIncoming = { ...incoming, reply: {
      cmid: 7, authorId: -groupId, date: 1_699_999_999_000,
    } };
    const parent = { from_id: -groupId, peer_id: peerId, conversation_message_id: 7, date: 1_699_999_999 };
    const reply = { from_id: 73, peer_id: peerId, conversation_message_id: 8, date: 1_700_000_000,
      reply_message: { from_id: -groupId, conversation_message_id: 7, date: 1_699_999_999 } };
    let items: Record<string, unknown>[] = [reply, parent];
    const call = vi.fn<VkApiCall>(async (method) => method === 'messages.getByConversationMessageId' ? { items } : []);
    const api = createVkApi(groupId, call);

    expect((await api.enrich(message)).verifiedReply).toEqual({ cmid: 7, authorId: -groupId });
    expect(call).toHaveBeenCalledWith('messages.getByConversationMessageId', { peer_id: peerId, conversation_message_ids: '8,7' });
    items = [reply, { ...parent, peer_id: peerId + 1 }];
    expect((await api.enrich(message)).verifiedReply).toBeUndefined();
    items = [{ ...reply, reply_message: { ...reply.reply_message, from_id: 79 } }, parent];
    expect((await api.enrich(message)).verifiedReply).toBeUndefined();
    items = [{ ...reply, reply_message: { ...reply.reply_message, peer_id: peerId + 1 } }, parent];
    expect((await api.enrich(message)).verifiedReply).toBeUndefined();
  });

  it('не требует списка участников для лички и не выводит ошибки поставщика', async () => {
    const call = vi.fn<VkApiCall>(async () => { throw new Error('synthetic-key'); });
    const api = createVkApi(groupId, call);
    expect(await api.enrich({ ...incoming, peerId: 73 })).toEqual({ isBot: 'unknown', isAdmin: 'unknown' });
    expect(call.mock.calls.map(([method]) => method)).toEqual(['users.get']);
  });
});
