import type { QuestionnaireInvitationPort } from '../../core/greetings/invitation';
import type { VkIncoming } from './normalize';
import type { PublishedPart } from '../../contracts/index';
import { randomInt } from 'node:crypto';
import type {
  CapabilityState,
  ChannelAdapter,
  ChatId,
  ConnectionScope,
  PlatformMessageId,
  SendResult,
  UserId,
} from '../../contracts/index';
import type { PublicationGuard, PublicationPort } from '../../core/index';
import type { Storage } from '../../storage/index';
import { createVkSdkApi, readVkHumanMembership } from './api';
import type { VkApi } from './api';
import { createVkInbound } from './inbound';
import type { VkInboundOptions } from './inbound';
import type { VkPollTransport } from './long-poll';
import { isVkGroupChat, vkRecord } from './normalize';
import { createVkOutbound, vkLocalId } from './outbound';
import { createVkIntroduction } from './introduction';
import { createVkAdministrationEvidence } from './administration-evidence';
import { createVkAdministrationDelivery } from './administration-delivery';
import { vkMessageLength } from './outbound-text';
import type { waitForVkRetry } from './rate-limit';

export interface VkChannelOptions extends VkInboundOptions {
  readonly chats: Pick<Storage['chats'], 'get'>;
  readonly owner?: UserId;
}

interface VkChannelDependencies {
  readonly api?: VkApi;
  readonly transport?: VkPollTransport;
  readonly wait?: typeof waitForVkRetry;
}

export function createVkChannel(
  options: VkChannelOptions,
  dependencies: VkChannelDependencies = {},
) {
  const signal = options.signal ?? new AbortController().signal;
  const api = dependencies.api ?? createVkSdkApi(options.groupId, options.token, signal);
  const inbound = createVkInbound(options, {
    api,
    ...(dependencies.transport ? { transport: dependencies.transport } : {}),
  });
  const outbound = createVkOutbound({
    groupId: options.groupId,
    api,
    ...(dependencies.wait ? { wait: dependencies.wait } : {}),
  });
  let typingFailed = 0;
  let invitationMentionsOmitted = 0;

  function guardFor(chatId: ChatId): PublicationGuard {
    const scope = options.lifecycle.admissionScope(chatId);
    function isCurrent() {
      return !signal.aborted && options.lifecycle.isAdmissionCurrent(scope);
    }
    return {
      signal,
      isCurrent,
      async allow() {
        if (!isCurrent()) return false;
        const settings = await options.chats.get(scope);
        return isCurrent() && settings?.enabled === true && settings.responseMode !== 'silent';
      },
    };
  }

  async function confirmServicePart(
    scope: ConnectionScope,
    text: string,
    guard: PublicationGuard & { readonly beforeSend?: () => boolean },
  ) {
    let receipt: PublishedPart | undefined;
    const outcome = await outbound.send({
      ...guard,
      chatId: scope.chatId,
      kind: 'service',
      text,
      sendId: randomInt(1, 0x80000000),
      confirmPart(part) {
        receipt = part;
      },
    });
    if (outcome.kind === 'delivered' && receipt) return { kind: 'delivered', receipt } as const;
    return { kind: outcome.kind === 'failed' ? 'failed' : 'unknown' } as const;
  }

  const publicationPort: PublicationPort = Object.freeze({
    canReply(scope, requestSignal, sourceId, guard) {
      const combined = AbortSignal.any([signal, requestSignal]);
      return outbound.canReply(scope.chatId, sourceId, {
        ...guard,
        signal: combined,
        isCurrent: () =>
          options.lifecycle.isAdmissionCurrent(scope) && (!guard || guard.isCurrent()),
      });
    },
    publish(input) {
      return outbound.send({
        ...input,
        chatId: input.scope.chatId,
        signal: AbortSignal.any([signal, input.signal]),
        isCurrent: () => options.lifecycle.isAdmissionCurrent(input.scope) && input.isCurrent(),
      });
    },
  } satisfies PublicationPort);

  const adapter = {
    platform: 'vk',
    mentionedPeople(text) {
      return [
        ...new Set(
          Array.from(
            text.matchAll(/\[id([1-9]\d*)\|[^\]\r\n]+\]/gu),
            (match) => `vk:${match[1]}` as UserId,
          ),
        ),
      ];
    },
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
          const readGuard = observedMembership
            ? { signal: guard.signal, isCurrent: guard.isCurrent }
            : guard;
          const result = vkRecord(
            await api.request(
              'messages.getConversationsById',
              { peer_ids: String(peer) },
              readGuard,
            ),
          );
          const row = Array.isArray(result?.items)
            ? result.items.map(vkRecord).find((item) => vkRecord(item?.peer)?.id === peer)
            : undefined;
          const allowed = vkRecord(row?.can_write)?.allowed;
          present = vkRecord(row?.chat_settings)?.state === 'in';
          if (!observedMembership || (await guard.allow())) {
            if (allowed === true) send = 'supported';
            else if (allowed === false) send = 'unsupported';
          }
        } catch {
          /* Без актуального ответа возможность остаётся неизвестной. */
        }
      }
      const membershipEvents: CapabilityState =
        peer === undefined || isVkGroupChat(peer)
          ? present && inbound.hasMembershipObservation(context.chatId)
            ? 'supported'
            : 'unknown'
          : 'unsupported';
      return Object.freeze({
        context: Object.freeze({ ...context }),
        observedAt: Date.now(),
        support: Object.freeze({
          send,
          reply: send,
          typing: peer !== undefined && peer > 0 && !isVkGroupChat(peer) ? send : 'unknown',
          getUserName: user !== undefined && user > 0 ? 'supported' : 'unknown',
          adminInfo: 'unknown',
          membershipEvents,
          directMessage:
            peer !== undefined && user === peer && peer > 0 && !isVkGroupChat(peer)
              ? send
              : 'unknown',
        }),
        maxMessageLength: peer === undefined ? 'unknown' : vkMessageLength,
        textFormats: Object.freeze(['plain'] as const),
      });
    },
    async send(message): Promise<SendResult> {
      const guard = guardFor(message.chatId);
      const ids: PlatformMessageId[] = [];
      const result = await outbound.send({
        ...message,
        ...guard,
        kind: 'answer',
        confirmPart(part) {
          if (!guard.isCurrent()) throw new Error('VK send: stale connection');
          ids.push(part.messageId);
        },
      });
      const [first, ...rest] = ids;
      if (result.kind !== 'delivered' || first === undefined)
        throw new Error(`VK send: ${result.kind}`);
      return Object.freeze([first, ...rest]);
    },
    async sendTyping(chatId) {
      try {
        await outbound.sendTyping(chatId, guardFor(chatId));
      } catch {
        typingFailed++;
      }
    },
    async humanMembership(scope, requestSignal) {
      const peer = vkLocalId(scope.chatId);
      if (peer === undefined) return { complete: false };
      return readVkHumanMembership(api.request, peer, {
        signal: AbortSignal.any([signal, requestSignal]),
        isCurrent: () => options.lifecycle.isAdmissionCurrent(scope),
      });
    },
    async getUserName(userId) {
      const id = vkLocalId(userId);
      return id === undefined ? null : api.getUserName(id);
    },
  } satisfies ChannelAdapter;

  return Object.freeze({
    ...adapter,
    administrationEvidence: createVkAdministrationEvidence(api, options.groupId),
    administrationDelivery: options.owner
      ? createVkAdministrationDelivery(api, outbound, options.owner, options.groupId)
      : undefined,
    async sendPersonalFile(sender: UserId, data: Buffer, guard: PublicationGuard) {
      const peer = vkLocalId(sender);
      if (
        !api.uploadPrivateDocument ||
        !peer ||
        peer <= 0 ||
        isVkGroupChat(peer) ||
        !guard.isCurrent() ||
        !(await guard.allow?.())
      )
        return false;
      if (
        !(await createVkAdministrationDelivery(api, outbound, sender, options.groupId).canWrite(
          guard,
        )) ||
        !(await guard.allow()) ||
        !guard.isCurrent()
      )
        return false;
      const attachment = await api.uploadPrivateDocument(peer, data);
      if (
        !/^doc-?\d+_\d+(?:_[a-zA-Z0-9]+)?$/u.test(attachment) ||
        !guard.isCurrent() ||
        !(await guard.allow?.())
      )
        return false;
      const result = await api.request(
        'messages.send',
        { peer_id: peer, attachment, random_id: randomInt(1, 0x80000000) },
        guard,
      );
      return typeof result === 'number' && result > 0;
    },
    async verifiedProfileReply(message: VkIncoming, guard: PublicationGuard) {
      if (message.peerId !== message.authorId || isVkGroupChat(message.peerId) || !message.reply)
        return null;
      const reply = (await api.enrich(message, guard)).verifiedReply;
      return reply?.authorId === -options.groupId && reply.cmid === message.reply.cmid
        ? String(reply.cmid)
        : null;
    },
    reminderDelivery(recipient: UserId) {
      return createVkAdministrationDelivery(api, outbound, recipient, options.groupId);
    },
    privateControlDelivery(sender: UserId, text: string, guard: PublicationGuard) {
      return createVkAdministrationDelivery(api, outbound, sender, options.groupId).deliver(
        text,
        guard,
      );
    },
    async replyPrivateControl(sender: UserId, text: string, guard: PublicationGuard) {
      await createVkAdministrationDelivery(api, outbound, sender, options.groupId).reply(
        text,
        guard,
      );
    },
    async replyGroupControl(scope: ConnectionScope, text: string, guard: PublicationGuard) {
      if (guard.isCurrent()) {
        await outbound.send({
          ...guard,
          chatId: scope.chatId,
          text,
          kind: 'answer',
          confirmPart() {},
        });
      }
    },
    async deliverGroupControl(
      scope: ConnectionScope,
      text: string,
      guard: PublicationGuard,
    ): Promise<PublishedPart | null> {
      const peer = vkLocalId(scope.chatId);
      if (peer === undefined || !isVkGroupChat(peer) || !guard.isCurrent()) return null;
      const outcome = await confirmServicePart(scope, text, guard);
      return outcome.kind === 'delivered' ? outcome.receipt : null;
    },
    async deliverQuestionnairePart(scope: ConnectionScope, text: string, guard: PublicationGuard) {
      const id = vkLocalId(scope.chatId);
      if (
        id === undefined ||
        id <= 0 ||
        Buffer.byteLength(text) > vkMessageLength.value ||
        !guard.isCurrent()
      )
        return { kind: 'failed' } as const;
      if (
        !isVkGroupChat(id) &&
        !(await createVkAdministrationDelivery(
          api,
          outbound,
          scope.chatId,
          options.groupId,
        ).canWrite(guard))
      )
        return { kind: 'failed' } as const;
      return confirmServicePart(scope, text, { ...guard, beforeSend: guard.isCurrent });
    },
    questionnaireMention(text: string): UserId | null {
      const bracket = /^\[id([1-9]\d*)\|[^\]\r\n]+\]$/u.exec(text);
      const plain = /^@id([1-9]\d*)$/u.exec(text);
      const id = bracket?.[1] ?? plain?.[1];
      if (!id) return null;
      const user = `vk:${id}` as const;
      const local = vkLocalId(user);
      return local !== undefined && !isVkGroupChat(local) ? user : null;
    },
    async sendGreeting(
      scope: ConnectionScope,
      text: string,
      sendId: number,
      guard: import('../../core/chat-onboarding/ports').IntroductionGuard & {
        beforeSend(): boolean;
      },
      confirmPart: (part: PublishedPart) => void,
    ) {
      const id = vkLocalId(scope.chatId);
      if (id === undefined || !isVkGroupChat(id)) return 'failed' as const;
      const result = await outbound.send({
        ...guard,
        chatId: scope.chatId,
        kind: 'service',
        text,
        sendId,
        confirmPart,
      });
      return result.kind;
    },
    async sendQuestionnaireInvitation(
      ...args: Parameters<QuestionnaireInvitationPort['sendInvitation']>
    ) {
      const [scope, sendId, guard, prepare, confirmPart] = args;
      const result = await outbound.sendInvitation({
        ...guard,
        chatId: scope.chatId,
        sendId,
        prepare,
        confirmPart,
        onOmitted(count) {
          invitationMentionsOmitted += count;
        },
      });
      return result.kind;
    },
    introduction: options.owner
      ? createVkIntroduction({ owner: options.owner, groupId: options.groupId, api, outbound })
      : undefined,
    startRouted: inbound.startRouted,
    async sendTypingForWork(
      scope: ConnectionScope,
      work: Pick<PublicationGuard, 'signal' | 'isCurrent'>,
    ) {
      if (!work.isCurrent() || work.signal.aborted) return;
      try {
        const guard = guardFor(scope.chatId);
        await outbound.sendTyping(scope.chatId, {
          ...guard,
          signal: AbortSignal.any([signal, work.signal]),
          isCurrent: () => guard.isCurrent() && work.isCurrent(),
        });
      } catch {
        typingFailed++;
      }
    },
    publicationPort,
    stats: () => Object.freeze({ ...inbound.stats(), typingFailed, invitationMentionsOmitted }),
  });
}
