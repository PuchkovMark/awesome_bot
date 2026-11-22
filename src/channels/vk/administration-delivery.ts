import type { UserId } from '../../contracts/index.js';
import type { VkApi } from './api.js';
import { isVkGroupChat, vkRecord } from './normalize.js';
import { createVkOutbound, vkLocalId } from './outbound.js';
import type { VkRequestGuard } from './rate-limit.js';

export function createVkAdministrationDelivery(api: Pick<VkApi,'request'>, outbound: ReturnType<typeof createVkOutbound>,
  owner: UserId, groupId: number) {
  const peer=vkLocalId(owner);
  const chatId=peer!==undefined && peer>0 && !isVkGroupChat(peer) ? `vk:${peer}` as const : undefined;
  async function canWrite(guard: VkRequestGuard) {
    if (chatId===undefined || guard.isCurrent?.()===false || guard.signal?.aborted) return false;
    try {
      const allowed=vkRecord(await api.request('messages.isMessagesFromGroupAllowed',{group_id:groupId,user_id:peer!},guard));
      if (allowed?.is_allowed!==1 && allowed?.is_allowed!==true) return false;
      const result=vkRecord(await api.request('messages.getConversationsById',{peer_ids:String(peer)},guard));
      const items=Array.isArray(result?.items) ? result.items.map(vkRecord).filter(row=>vkRecord(row?.peer)?.id===peer) : [];
      return items.length===1 && vkRecord(items[0]?.can_write)?.allowed===true;
    } catch { return false; }
  }
  return Object.freeze({
    async reply(text: string, guard: VkRequestGuard) {
      if (chatId!==undefined && await canWrite(guard)) {
        await outbound.send({...guard,chatId,text,kind:'answer',confirmPart(){ /* Служебный текст вне журнала. */ }});
      }
    },
    async publish(text: string, sendId: number, receivedId: (messageId: string) => void, guard: VkRequestGuard) {
      if (chatId===undefined || !await canWrite(guard)) return 'failed' as const;
      return (await outbound.send({...guard,chatId,text,kind:'service',sendId,receivedId,confirmPart(){}})).kind;
    },
    async confirm(text: string, receipt: string, since: number, guard: VkRequestGuard) {
      return chatId!==undefined && await outbound.confirmService(chatId,text,receipt,since,guard);
    },
  });
}
