import type { CapabilityState, ChannelAdapter, ChatId, PlatformMessageId, SendResult } from '../../contracts/index.js';
import type { PublicationGuard, PublicationPort } from '../../core/index.js';
import type { Storage } from '../../storage/index.js';
import { createVkSdkApi } from './api.js';
import type { VkApi } from './api.js';
import { createVkInbound } from './inbound.js';
import type { VkInboundOptions } from './inbound.js';
import type { VkPollTransport } from './long-poll.js';
import { isVkGroupChat, vkRecord } from './normalize.js';
import { createVkOutbound, vkLocalId } from './outbound.js';
import { vkMessageLength } from './outbound-text.js';
import type { waitForVkRetry } from './rate-limit.js';

export interface VkChannelOptions extends VkInboundOptions {
  readonly chats: Pick<Storage['chats'], 'get'>;
}

interface VkChannelDependencies {
  readonly api?: VkApi;
  readonly transport?: VkPollTransport;
  readonly wait?: typeof waitForVkRetry;
}

export function createVkChannel(options: VkChannelOptions, dependencies: VkChannelDependencies = {}) {
  const api = dependencies.api ?? createVkSdkApi(options.groupId, options.token);
  const inbound = createVkInbound(options, {
    api,
    ...(dependencies.transport ? { transport: dependencies.transport } : {}),
  });
  const outbound = createVkOutbound({
    groupId: options.groupId, api, ...(dependencies.wait ? { wait: dependencies.wait } : {}),
  });
  const signal = options.signal ?? new AbortController().signal;
  let typingFailed = 0;

  function guardFor(chatId: ChatId): PublicationGuard {
    const scope = options.lifecycle.admissionScope(chatId);
    function isCurrent() {
      return !signal.aborted && options.lifecycle.isAdmissionCurrent(scope);
    }
    return { signal, isCurrent, async allow() {
      if (!isCurrent()) return false;
      const settings = await options.chats.get(scope);
      return isCurrent() && settings?.enabled === true && settings.responseMode !== 'silent';
    } };
  }

  const publicationPort: PublicationPort = Object.freeze({
    canReply(scope, requestSignal, sourceId, guard) {
      const combined = AbortSignal.any([signal, requestSignal]);
      return outbound.canReply(scope.chatId, sourceId, {
        ...guard, signal: combined,
        isCurrent: () => options.lifecycle.isAdmissionCurrent(scope) && (!guard || guard.isCurrent()),
      });
    },
    publish(input) {
      return outbound.send({
        ...input, chatId: input.scope.chatId, signal: AbortSignal.any([signal, input.signal]),
        isCurrent: () => options.lifecycle.isAdmissionCurrent(input.scope) && input.isCurrent(),
      });
    },
  } satisfies PublicationPort);

  const adapter: ChannelAdapter = {
    platform: 'vk',
    start: inbound.start,
    async capabilities(context) {
      const peer = vkLocalId(context.chatId);
      const user = context.userId === undefined ? undefined : vkLocalId(context.userId);
      let send: CapabilityState = 'unknown';
      if (peer !== undefined) {
        try {
          const result = vkRecord(await api.request('messages.getConversationsById', { peer_ids: String(peer) }, guardFor(context.chatId)));
          const row = Array.isArray(result?.items)
            ? result.items.map(vkRecord).find(item => vkRecord(item?.peer)?.id === peer)
            : undefined;
          const allowed = vkRecord(row?.can_write)?.allowed;
          if (allowed === true) send = 'supported';
          else if (allowed === false) send = 'unsupported';
        } catch { /* Без актуального ответа возможность остаётся неизвестной. */ }
      }
      return Object.freeze({
        context: Object.freeze({ ...context }), observedAt: Date.now(),
        support: Object.freeze({
          send, reply: send,
          typing: peer !== undefined && peer > 0 && !isVkGroupChat(peer) ? send : 'unknown',
          getUserName: user !== undefined && user > 0 ? 'supported' : 'unknown',
          adminInfo: 'unknown', membershipEvents: 'unsupported',
          directMessage: peer !== undefined && user === peer && peer > 0 && !isVkGroupChat(peer) ? send : 'unknown',
        }),
        maxMessageLength: peer === undefined ? 'unknown' : vkMessageLength,
        textFormats: Object.freeze(['plain'] as const),
      });
    },
    async send(message): Promise<SendResult> {
      const guard = guardFor(message.chatId);
      const ids: PlatformMessageId[] = [];
      const result = await outbound.send({ ...message, ...guard, kind: 'answer', confirmPart(part) {
        if (!guard.isCurrent()) throw new Error('VK send: stale connection');
        ids.push(part.messageId);
      } });
      const [first, ...rest] = ids;
      if (result.kind !== 'delivered' || first === undefined) throw new Error(`VK send: ${result.kind}`);
      return Object.freeze([first, ...rest]);
    },
    async sendTyping(chatId) {
      try { await outbound.sendTyping(chatId, guardFor(chatId)); }
      catch { typingFailed++; }
    },
    async getUserName(userId) {
      const id = vkLocalId(userId);
      return id === undefined ? null : api.getUserName(id);
    },
  };

  return Object.freeze({
    ...adapter,
    startRouted: inbound.startRouted,
    publicationPort,
    stats: () => Object.freeze({ ...inbound.stats(), typingFailed }),
  });
}
