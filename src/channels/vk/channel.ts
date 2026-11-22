import type { CapabilityState, ChannelAdapter, ChatId, ConnectionScope, PlatformMessageId, SendResult, UserId } from '../../contracts/index.js';
import type { PublicationGuard, PublicationPort } from '../../core/index.js';
import type { Storage } from '../../storage/index.js';
import { createVkSdkApi } from './api.js';
import type { VkApi } from './api.js';
import { createVkInbound } from './inbound.js';
import type { VkInboundOptions } from './inbound.js';
import type { VkPollTransport } from './long-poll.js';
import { isVkGroupChat, vkRecord } from './normalize.js';
import { createVkOutbound, vkLocalId } from './outbound.js';
import { createVkIntroduction } from './introduction.js';
import { createVkAdministrationEvidence } from './administration-evidence.js';
import { createVkAdministrationDelivery } from './administration-delivery.js';
import { vkMessageLength } from './outbound-text.js';
import type { waitForVkRetry } from './rate-limit.js';

export interface VkChannelOptions extends VkInboundOptions {
  readonly chats: Pick<Storage['chats'], 'get'>;
  readonly owner?: UserId;
}

interface VkChannelDependencies {
  readonly api?: VkApi;
  readonly transport?: VkPollTransport;
  readonly wait?: typeof waitForVkRetry;
}

export function createVkChannel(options: VkChannelOptions, dependencies: VkChannelDependencies = {}) {
  const signal = options.signal ?? new AbortController().signal;
  const api = dependencies.api ?? createVkSdkApi(options.groupId, options.token, signal);
  const inbound = createVkInbound(options, {
    api,
    ...(dependencies.transport ? { transport: dependencies.transport } : {}),
  });
  const outbound = createVkOutbound({
    groupId: options.groupId, api, ...(dependencies.wait ? { wait: dependencies.wait } : {}),
  });
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
      const observedMembership = inbound.hasMembershipObservation(context.chatId);
      let send: CapabilityState = 'unknown';
      let present = false;
      if (peer !== undefined) {
        try {
          const guard = guardFor(context.chatId);
          const readGuard = observedMembership ? { signal: guard.signal, isCurrent: guard.isCurrent } : guard;
          const result = vkRecord(await api.request('messages.getConversationsById', { peer_ids: String(peer) }, readGuard));
          const row = Array.isArray(result?.items)
            ? result.items.map(vkRecord).find(item => vkRecord(item?.peer)?.id === peer)
            : undefined;
          const allowed = vkRecord(row?.can_write)?.allowed;
          present = vkRecord(row?.chat_settings)?.state === 'in';
          if (!observedMembership || await guard.allow()) {
            if (allowed === true) send = 'supported';
            else if (allowed === false) send = 'unsupported';
          }
        } catch { /* Без актуального ответа возможность остаётся неизвестной. */ }
      }
      const membershipEvents: CapabilityState = peer === undefined || isVkGroupChat(peer)
        ? (present && inbound.hasMembershipObservation(context.chatId) ? 'supported' : 'unknown')
        : 'unsupported';
      return Object.freeze({
        context: Object.freeze({ ...context }), observedAt: Date.now(),
        support: Object.freeze({
          send, reply: send,
          typing: peer !== undefined && peer > 0 && !isVkGroupChat(peer) ? send : 'unknown',
          getUserName: user !== undefined && user > 0 ? 'supported' : 'unknown',
          adminInfo: 'unknown', membershipEvents,
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
    administrationEvidence: createVkAdministrationEvidence(api,options.groupId),
    administrationDelivery: options.owner ? createVkAdministrationDelivery(api,outbound,options.owner,options.groupId) : undefined,
    replyPrivateControl(sender: UserId,text: string,guard: PublicationGuard) {
      return createVkAdministrationDelivery(api,outbound,sender,options.groupId).reply(text,guard);
    },
    async replyGroupControl(scope: ConnectionScope,text: string,guard: PublicationGuard) {
      if (guard.isCurrent()) {
        await outbound.send({...guard,chatId:scope.chatId,text,kind:'answer',confirmPart(){}});
      }
    },
    introduction: options.owner ? createVkIntroduction({owner: options.owner,groupId:options.groupId,api,outbound}) : undefined,
    startRouted: inbound.startRouted,
    async sendTypingForWork(scope: ConnectionScope,
      work: Pick<PublicationGuard, 'signal' | 'isCurrent'>) {
      if (!work.isCurrent() || work.signal.aborted) return;
      try {
        const guard = guardFor(scope.chatId);
        await outbound.sendTyping(scope.chatId, {
          ...guard, signal: AbortSignal.any([signal, work.signal]),
          isCurrent: () => guard.isCurrent() && work.isCurrent(),
        });
      } catch { typingFailed++; }
    },
    publicationPort,
    stats: () => Object.freeze({ ...inbound.stats(), typingFailed }),
  });
}
