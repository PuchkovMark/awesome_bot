import type { UserId } from '../../contracts/index';
import type { VkApi } from './api';
import { isVkGroupChat, vkRecord } from './normalize';
import { createVkOutbound, vkLocalId } from './outbound';
import type { VkInlineKeyboard } from './outbound';
import type { VkRequestGuard } from './rate-limit';

export function createVkAdministrationDelivery(
  api: Pick<VkApi, 'request'>,
  outbound: ReturnType<typeof createVkOutbound>,
  recipient: UserId,
  groupId: number,
) {
  const peer = vkLocalId(recipient);
  const chatId =
    peer !== undefined && peer > 0 && !isVkGroupChat(peer) ? (`vk:${peer}` as const) : undefined;
  async function permission(guard: VkRequestGuard): Promise<'allowed' | 'failed' | 'unknown'> {
    if (chatId === undefined || guard.isCurrent?.() === false || guard.signal?.aborted)
      return 'failed';
    try {
      const allowed = vkRecord(
        await api.request(
          'messages.isMessagesFromGroupAllowed',
          { group_id: groupId, user_id: peer! },
          guard,
        ),
      );
      if (allowed?.is_allowed === 0 || allowed?.is_allowed === false) return 'failed';
      if (allowed?.is_allowed !== 1 && allowed?.is_allowed !== true) return 'unknown';
      const result = vkRecord(
        await api.request('messages.getConversationsById', { peer_ids: String(peer) }, guard),
      );
      const items = Array.isArray(result?.items)
        ? result.items.map(vkRecord).filter((row) => vkRecord(row?.peer)?.id === peer)
        : [];
      const writable = items.length === 1 ? vkRecord(items[0]?.can_write)?.allowed : undefined;
      if (writable === false) return 'failed';
      return writable === true ? 'allowed' : 'unknown';
    } catch {
      return 'unknown';
    }
  }
  const canWrite = async (guard: VkRequestGuard) => (await permission(guard)) === 'allowed';
  async function deliver(text: string, guard: VkRequestGuard, inlineKeyboard?: VkInlineKeyboard) {
    if (chatId === undefined) return 'failed' as const;
    const access = await permission(guard);
    if (access !== 'allowed') return access;
    return (
      await outbound.send({
        ...guard,
        chatId,
        text,
        kind: 'answer',
        ...(inlineKeyboard ? { inlineKeyboard } : {}),
        confirmPart() {
          /* Служебный текст вне журнала. */
        },
      })
    ).kind;
  }
  return Object.freeze({
    canWrite,
    deliver,
    async reply(text: string, guard: VkRequestGuard, inlineKeyboard?: VkInlineKeyboard) {
      await deliver(text, guard, inlineKeyboard);
    },
    async publish(
      text: string,
      sendId: number,
      receivedId: (messageId: string) => void,
      guard: VkRequestGuard,
      replayUntil?: number,
    ) {
      if (chatId === undefined || !(await canWrite(guard))) return 'failed' as const;
      return (
        await outbound.send({
          ...guard,
          chatId,
          text,
          kind: 'service',
          sendId,
          ...(replayUntil === undefined ? {} : { replayUntil }),
          receivedId,
          confirmPart() {},
        })
      ).kind;
    },
    async confirm(text: string, receipt: string, since: number, guard: VkRequestGuard) {
      return (
        chatId !== undefined && (await outbound.confirmService(chatId, text, receipt, since, guard))
      );
    },
  });
}
