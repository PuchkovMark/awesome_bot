import { randomInt } from 'node:crypto';
import type { OutgoingMessage, PublishedPart } from '../../contracts/index';
import { VkApiError, vkErrorCode, vkReadRetryable } from './api';
import type { VkApi } from './api';
import { vkCmid, vkId, vkRecord } from './normalize';
import { splitVkText } from './outbound-text';
import { VkRequestCancelled, waitForVkRetry } from './rate-limit';
import type { VkRequestGuard } from './rate-limit';

const rejected = new Set([5, 6, 7, 15, 27, 100, 900, 901, 902, 910, 914, 917, 921, 925, 927, 932]);
const issuedIdsLimit = 65_536;

type SendOutcome = { readonly kind: 'delivered'; readonly confirmedParts: number }
  | { readonly kind: 'failed' | 'unknown'; readonly confirmedParts: number };

export interface VkSendRequest extends OutgoingMessage, VkRequestGuard {
  readonly kind: 'answer' | 'notice' | 'service';
  readonly sendId?: number;
  readonly replayUntil?: number;
  readonly receivedId?: (messageId: string) => void;
  readonly confirmPart: (part: PublishedPart) => void | Promise<void>;
}

interface VkMessage {
  readonly cmid: number;
  readonly author: number;
  readonly date: number;
  readonly text: string;
  readonly reply: Record<string, unknown> | undefined;
}

export function vkLocalId(value: string): number | undefined {
  if (!value.startsWith('vk:')) return undefined;
  const id = vkId(Number(value.slice(3)));
  return id !== undefined && value === `vk:${id}` ? id : undefined;
}

function localMessageId(value: string | undefined): number | undefined {
  const id = vkCmid(Number(value));
  return id !== undefined && value === String(id) ? id : undefined;
}

export function createVkOutbound(options: {
  readonly groupId: number;
  readonly api: Pick<VkApi, 'request'>;
  readonly wait?: typeof waitForVkRetry;
}) {
  const { groupId } = options;
  const request = options.api.request;
  const wait = options.wait ?? waitForVkRetry;
  const issuedIds = new Set<number>();

  function nextRandomId(): number {
    let id: number;
    do { id = randomInt(1, 2_147_483_648); } while (issuedIds.has(id));
    if (issuedIds.size >= issuedIdsLimit) {
      const oldest = issuedIds.values().next().value;
      if (oldest !== undefined) issuedIds.delete(oldest);
    }
    issuedIds.add(id);
    return id;
  }

  async function lookup(peer: number, cmid: number, guard: VkRequestGuard): Promise<VkMessage | undefined> {
    const response = vkRecord(await request('messages.getByConversationMessageId', {
      peer_id: peer, conversation_message_ids: String(cmid),
    }, guard));
    if (!Array.isArray(response?.items)) return undefined;
    const matched = response.items.map(vkRecord).filter(row => row?.peer_id === peer && row.conversation_message_id === cmid);
    const row = matched.length === 1 ? matched[0] : undefined;
    const author = vkId(row?.from_id);
    if (!row || !author || typeof row.date !== 'number' || row.date <= 0
      || !Number.isSafeInteger(row.date * 1000) || !Number.isSafeInteger(row.date) || typeof row.text !== 'string') return undefined;
    return { cmid, author, date: row.date, text: row.text, reply: vkRecord(row.reply_message) };
  }

  async function lookupConfirmed(peer: number, cmid: number, guard: VkRequestGuard): Promise<VkMessage | undefined> {
    for (let retry = 0; ; retry++) {
      try {
        const row = await lookup(peer, cmid, guard);
        if (row || retry >= 2) return row;
      } catch (error) {
        if (!vkReadRetryable(error) || retry >= 2) return undefined;
      }
      try { await wait(retry, guard.signal); } catch { return undefined; }
    }
  }

  async function sendPart(peer: number, text: string, parent: VkMessage | undefined, input: VkSendRequest) {
    const sendId = input.kind === 'service' ? input.sendId : undefined;
    const replayUntil = input.replayUntil;
    const guard = replayUntil === undefined ? input : {
      ...input,
      isCurrent: () => Date.now() < replayUntil && (!input.isCurrent || input.isCurrent()),
    };
    const params = {
      peer_ids: String(peer), message: text, random_id: sendId ?? nextRandomId(), dont_parse_links: 1, disable_mentions: 1,
      ...(parent ? { forward: JSON.stringify({ peer_id: peer, conversation_message_ids: [parent.cmid], is_reply: true }) } : {}),
    };
    for (let retry = 0; ; retry++) {
      try {
        if (guard.signal?.aborted || (guard.isCurrent && !guard.isCurrent())) throw new VkRequestCancelled();
        const response = await request('messages.send', params, guard);
        const item = Array.isArray(response) && response.length === 1 ? vkRecord(response[0]) : undefined;
        if (item?.peer_id !== peer) throw new VkApiError(undefined);
        const cmid = vkCmid(item.conversation_message_id);
        if (item.error !== undefined) {
          const hasReceipt = cmid !== undefined || vkCmid(item.message_id) !== undefined;
          throw new VkApiError(hasReceipt ? undefined : vkErrorCode(vkRecord(item.error)?.error_code));
        }
        if (!cmid) throw new VkApiError(undefined);
        return cmid;
      } catch (error) {
        if (replayUntil !== undefined || !(error instanceof VkApiError) || error.code !== 6 || retry >= 2) throw error;
        await wait(retry, guard.signal);
      }
    }
  }

  return Object.freeze({
    async confirmService(chatId: OutgoingMessage['chatId'], text: string, receipt: string, notBefore: number, guard: VkRequestGuard) {
      const peer = vkLocalId(chatId);
      const cmid = localMessageId(receipt);
      if (peer === undefined || cmid === undefined) return false;
      const row = await lookupConfirmed(peer,cmid,guard);
      return row?.author === -groupId && row.text === text && row.reply === undefined && row.date >= Math.floor(notBefore / 1000);
    },
    async canReply(chatId: VkSendRequest['chatId'], sourceId: string | undefined, guard: VkRequestGuard): Promise<boolean> {
      const peer = vkLocalId(chatId);
      const cmid = localMessageId(sourceId);
      if (peer === undefined || cmid === undefined) return false;
      try { return (await lookup(peer, cmid, guard)) !== undefined; } catch { return false; }
    },
    async send(input: VkSendRequest): Promise<SendOutcome> {
      const peer = vkLocalId(input.chatId);
      if (peer === undefined) return { kind: 'failed', confirmedParts: 0 };
      const chunks = splitVkText(input.text);
      const replyId = localMessageId(input.replyToMessageId);
      if (chunks.length === 0 || (input.replyToMessageId !== undefined && replyId === undefined)
        || (input.kind === 'notice' && (chunks.length !== 1 || replyId === undefined))
        || (input.kind === 'service' && (chunks.length !== 1 || replyId !== undefined ||
          input.sendId === undefined || !Number.isInteger(input.sendId) || input.sendId <= 0 || input.sendId > 0x7fffffff))) {
        return { kind: 'failed', confirmedParts: 0 };
      }
      let parent: VkMessage | undefined;
      if (replyId !== undefined) {
        try { parent = await lookup(peer, replyId, input); } catch { /* Перед отправкой проверяется область источника. */ }
        if (!parent) return { kind: 'failed', confirmedParts: 0 };
      }
      const confirmedIds = new Set<number>();
      for (const text of chunks) {
        const confirmedParts = confirmedIds.size;
        const expectedParent = confirmedParts === 0 ? parent : undefined;
        let cmid: number;
        try {
          cmid = await sendPart(peer, text, expectedParent, input);
        } catch (error) {
          const denied = error instanceof VkRequestCancelled
            || (error instanceof VkApiError && error.code !== undefined && rejected.has(error.code));
          return { kind: denied ? 'failed' : 'unknown', confirmedParts };
        }
        if (confirmedIds.has(cmid)) return { kind: 'unknown', confirmedParts };
        input.receivedId?.(String(cmid));
        const observed = await lookupConfirmed(peer, cmid, input);
        if (!observed || observed.author !== -groupId) return { kind: 'unknown', confirmedParts };
        const linked = expectedParent !== undefined && observed.reply?.conversation_message_id === expectedParent.cmid
          && observed.reply.from_id === expectedParent.author && observed.reply.date === expectedParent.date;
        const expectedLink = expectedParent === undefined ? observed.reply === undefined : linked;
        if (input.kind === 'notice' && !linked) return { kind: 'unknown', confirmedParts };
        await input.confirmPart({
          messageId: String(cmid), userId: `vk:${observed.author}`, authorName: '',
          text: observed.text, timestamp: observed.date * 1000,
          ...(linked ? { replyToMessageId: String(expectedParent.cmid) } : {}),
        });
        confirmedIds.add(cmid);
        if (observed.text !== text || !expectedLink) return { kind: 'unknown', confirmedParts: confirmedIds.size };
      }
      return { kind: 'delivered', confirmedParts: confirmedIds.size };
    },
    async sendTyping(chatId: VkSendRequest['chatId'], guard: VkRequestGuard): Promise<void> {
      const peer = vkLocalId(chatId);
      if (peer === undefined) throw new VkRequestCancelled();
      const response = await request('messages.setActivity', { peer_id: peer, type: 'typing', group_id: groupId }, guard);
      if (response !== 1) throw new VkApiError(undefined);
    },
  });
}
