import type { ChatId, ConnectionScope, UserId } from '../../contracts/index';
import type {
  IntroductionGuard,
  IntroductionPort,
  ServiceDelivery,
  WritePermission,
} from '../../core/chat-onboarding/ports';
import type { VkApi } from './api';
import { VkApiError } from './api';
import { isVkGroupChat, vkRecord } from './normalize';
import type { createVkOutbound } from './outbound';
import { vkLocalId } from './outbound';

// Повтор в Test Bot через 15,6 секунды вернул ту же запись. В рабочем окне оставляем запас.
export const vkIntroductionReplayWindowMs = 14_000;

export function describeVkRights(administration: boolean): string {
  return administration
    ? 'Режим VK: отправка сообщений доступна.'
    : 'Ограниченный режим VK: права администратора сообщества в беседе не подтверждены.';
}

export function createVkIntroduction(options: {
  readonly owner: UserId;
  readonly groupId: number;
  readonly api: Pick<VkApi, 'request'>;
  readonly outbound: ReturnType<typeof createVkOutbound>;
}): IntroductionPort {
  function address(scope: ConnectionScope, target: 'chat' | 'owner'): ChatId | undefined {
    const group = vkLocalId(scope.chatId);
    if (group === undefined || group <= 0) return undefined;
    if (target === 'chat') return scope.chatId;
    if (!isVkGroupChat(group)) return undefined;
    const owner = vkLocalId(options.owner);
    return owner !== undefined && owner > 0 && !isVkGroupChat(owner)
      ? (options.owner as unknown as ChatId)
      : undefined;
  }

  return Object.freeze({
    async writing(
      scope: ConnectionScope,
      target: 'chat' | 'owner',
      guard: IntroductionGuard,
    ): Promise<WritePermission> {
      const chatId = address(scope, target);
      if (!chatId || !guard.isCurrent()) return 'unknown';
      const peer = vkLocalId(chatId)!;
      try {
        if (target === 'owner') {
          const result = vkRecord(
            await options.api.request(
              'messages.isMessagesFromGroupAllowed',
              {
                group_id: options.groupId,
                user_id: peer,
              },
              guard,
            ),
          );
          if (!guard.isCurrent()) return 'unknown';
          if (result?.is_allowed === 0 || result?.is_allowed === false) return 'denied';
          if (result?.is_allowed !== 1 && result?.is_allowed !== true) return 'unknown';
        }
        const result = vkRecord(
          await options.api.request(
            'messages.getConversationsById',
            { peer_ids: String(peer) },
            guard,
          ),
        );
        const row = Array.isArray(result?.items)
          ? result.items.map(vkRecord).find((value) => vkRecord(value?.peer)?.id === peer)
          : undefined;
        if (
          !guard.isCurrent() ||
          (target === 'chat' && vkRecord(row?.chat_settings)?.state !== 'in')
        )
          return 'unknown';
        const allowed = vkRecord(row?.can_write)?.allowed;
        if (allowed === true) return 'allowed';
        if (allowed === false) return 'denied';
        return 'unknown';
      } catch (error) {
        return guard.isCurrent() &&
          error instanceof VkApiError &&
          [901, 902, 917, 925, 932].includes(error.code ?? 0)
          ? 'denied'
          : 'unknown';
      }
    },
    async publish(
      scope: ConnectionScope,
      target: 'chat' | 'owner',
      text: string,
      sendId: number,
      guard: IntroductionGuard,
      replayUntil?: number,
    ): Promise<ServiceDelivery> {
      const chatId = address(scope, target);
      if (!chatId || !guard.isCurrent()) return { kind: 'failed' };
      let receipt: string | undefined;
      const result = await options.outbound.send({
        ...guard,
        kind: 'service',
        chatId,
        text,
        sendId,
        ...(replayUntil === undefined ? {} : { replayUntil }),
        confirmPart(part) {
          receipt = part.messageId;
        },
      });
      return result.kind === 'delivered' && receipt
        ? { kind: 'delivered', receipt }
        : { kind: result.kind === 'failed' ? 'failed' : 'unknown' };
    },
    async hasAdministration(scope: ConnectionScope, guard: IntroductionGuard) {
      const chatId = address(scope, 'chat');
      if (!chatId || !guard.isCurrent()) return false;
      try {
        const result = vkRecord(
          await options.api.request(
            'messages.getConversationMembers',
            { peer_id: vkLocalId(chatId)! },
            guard,
          ),
        );
        return (
          guard.isCurrent() &&
          Array.isArray(result?.items) &&
          result.items
            .map(vkRecord)
            .some((item) => item?.member_id === -options.groupId && item.is_admin === true)
        );
      } catch {
        return false;
      }
    },
    async confirm(
      scope: ConnectionScope,
      text: string,
      receipt: string,
      notBefore: number,
      guard: IntroductionGuard,
    ) {
      const chatId = address(scope, 'chat');
      return (
        chatId !== undefined &&
        (await options.outbound.confirmService(chatId, text, receipt, notBefore, guard)) &&
        guard.isCurrent()
      );
    },
  });
}
