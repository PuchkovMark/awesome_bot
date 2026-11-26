import type {
  ConnectionScope,
  KnownBoolean,
  LifecycleObservation,
  UserId,
} from '../../contracts/index';
import type { AdministrationInvite } from '../../storage/lifecycle-store';
import type { VkApi } from './api';
import { isVkGroupChat, vkId, vkRecord } from './normalize';
import { vkLocalId } from './outbound';
import type { VkRequestGuard } from './rate-limit';

function humanId(value: unknown): number | undefined {
  const id = vkId(value);
  return id !== undefined && id > 0 && !isVkGroupChat(id) ? id : undefined;
}

export function createVkAdministrationEvidence(api: Pick<VkApi, 'request'>, groupId: number) {
  const community = -groupId;
  const unavailable = {
    observation: { confidence: 'unavailable', bot: 'unknown' } satisfies LifecycleObservation,
    communityAdmin: 'unknown' as KnownBoolean,
  };
  async function members(peer: number, ids: readonly number[], guard: VkRequestGuard) {
    const response = vkRecord(
      await api.request(
        'messages.getConversationMembers',
        { peer_id: peer, member_ids: [...new Set(ids)].join(',') },
        guard,
      ),
    );
    return Array.isArray(response?.items)
      ? response.items.map(vkRecord).filter((row) => row !== undefined)
      : [];
  }
  async function invitationMatches(
    peer: number,
    invite: AdministrationInvite,
    inviter: number,
    guard: VkRequestGuard,
  ) {
    try {
      const proof = vkRecord(
        await api.request(
          'messages.getByConversationMessageId',
          { peer_id: peer, conversation_message_ids: String(invite.messageId) },
          guard,
        ),
      );
      const items = Array.isArray(proof?.items)
        ? proof.items
            .map(vkRecord)
            .filter(
              (row) => row?.peer_id === peer && row.conversation_message_id === invite.messageId,
            )
        : [];
      const message = items.length === 1 ? items[0] : undefined;
      const action = vkRecord(message?.action);
      return (
        message?.from_id === inviter &&
        message.date === invite.timestamp / 1000 &&
        action?.type === 'chat_invite_user' &&
        action.member_id === community
      );
    } catch {
      return false;
    }
  }

  return Object.freeze({
    async confirmReplacement(
      chatId: import('../../contracts/index').ChatId,
      departure: number,
      arrival: number,
      guard: VkRequestGuard,
    ) {
      const peer = vkLocalId(chatId);
      if (!peer || !isVkGroupChat(peer) || guard.isCurrent?.() === false) return false;
      try {
        const result = vkRecord(
          await api.request(
            'messages.getByConversationMessageId',
            { peer_id: peer, conversation_message_ids: `${departure},${arrival}` },
            guard,
          ),
        );
        const entries = Array.isArray(result?.items)
          ? result.items.map(vkRecord).filter((r) => r?.peer_id === peer)
          : [];
        const type = (id: number) => {
          const rows = entries.filter((r) => r?.conversation_message_id === id);
          const action = rows.length === 1 ? vkRecord(rows[0]?.action) : undefined;
          return action?.member_id === community ? action.type : undefined;
        };
        return (
          !guard.signal?.aborted &&
          guard.isCurrent?.() !== false &&
          type(departure) === 'chat_kick_user' &&
          type(arrival) === 'chat_invite_user'
        );
      } catch {
        return false;
      }
    },
    async canWriteGroup(chatId: import('../../contracts/index').ChatId, guard: VkRequestGuard) {
      const peer = vkLocalId(chatId);
      if (!peer || !isVkGroupChat(peer) || guard.isCurrent?.() === false) return false;
      try {
        const result = vkRecord(
          await api.request('messages.getConversationsById', { peer_ids: String(peer) }, guard),
        );
        const rows = Array.isArray(result?.items)
          ? result.items.map(vkRecord).filter((row) => vkRecord(row?.peer)?.id === peer)
          : [];
        return (
          !guard.signal?.aborted &&
          guard.isCurrent?.() !== false &&
          rows.length === 1 &&
          vkRecord(rows[0]?.chat_settings)?.state === 'in' &&
          vkRecord(rows[0]?.can_write)?.allowed === true
        );
      } catch {
        return false;
      }
    },
    async observe(
      scope: ConnectionScope,
      input: {
        readonly invite: AdministrationInvite | undefined;
        readonly admins: readonly UserId[];
      },
      guard: VkRequestGuard,
    ): Promise<{
      readonly observation: LifecycleObservation;
      readonly communityAdmin: KnownBoolean;
    }> {
      const peer = vkLocalId(scope.chatId);
      if (peer === undefined || !isVkGroupChat(peer)) return unavailable;
      try {
        const result = vkRecord(
          await api.request('messages.getConversationsById', { peer_ids: String(peer) }, guard),
        );
        const rows = Array.isArray(result?.items)
          ? result.items.map(vkRecord).filter((row) => vkRecord(row?.peer)?.id === peer)
          : [];
        const settings = rows.length === 1 ? vkRecord(rows[0]?.chat_settings) : undefined;
        if (guard.isCurrent?.() === false) return unavailable;
        if (
          settings?.state === 'kicked' ||
          settings?.state === 'left' ||
          settings?.state === 'out'
        ) {
          return {
            observation: { confidence: 'uncertain', bot: 'unknown' },
            communityAdmin: 'unknown',
          };
        }
        if (settings?.state !== 'in') return unavailable;
        const owner = humanId(settings.owner_id);
        const inviter = input.invite ? humanId(vkLocalId(input.invite.actorId)) : undefined;
        const ids = input.admins
          .map((id) => humanId(vkLocalId(id)))
          .filter((id) => id !== undefined);
        if (owner !== undefined) ids.push(owner);
        if (inviter !== undefined) ids.push(inviter);
        const roster = await members(peer, [community, ...ids], guard);
        const communities = roster.filter((row) => row.member_id === community);
        if (communities.length !== 1 || guard.isCurrent?.() === false) return unavailable;
        const bot = communities[0]!;
        const owners = roster.filter((row) => row.is_owner === true);
        const creatorId: UserId | undefined =
          owner !== undefined && owners.length === 1 && owners[0]?.member_id === owner
            ? `vk:${owner}`
            : undefined;
        let inviterId: UserId | undefined;
        if (
          input.invite &&
          inviter !== undefined &&
          bot.invited_by === inviter &&
          bot.join_date === input.invite.timestamp / 1000 &&
          (await invitationMatches(peer, input.invite, inviter, guard))
        )
          inviterId = input.invite.actorId;
        if (guard.isCurrent?.() === false) return unavailable;
        const present = new Set<UserId>();
        for (const id of ids) {
          if (roster.filter((row) => row.member_id === id).length === 1) present.add(`vk:${id}`);
        }
        return {
          communityAdmin: typeof bot.is_admin === 'boolean' ? bot.is_admin : 'unknown',
          observation: {
            confidence: 'confirmed',
            bot: 'present',
            ...(creatorId === undefined ? {} : { creatorId }),
            ...(inviterId === undefined ? {} : { inviterId }),
            members: { complete: false, ids: [...present] },
          },
        };
      } catch {
        return unavailable;
      }
    },
    async hasMember(
      scope: ConnectionScope,
      userId: UserId,
      guard: VkRequestGuard,
    ): Promise<boolean> {
      const peer = vkLocalId(scope.chatId),
        user = humanId(vkLocalId(userId));
      if (
        peer === undefined ||
        !isVkGroupChat(peer) ||
        user === undefined ||
        guard.isCurrent?.() === false
      )
        return false;
      try {
        const roster = await members(peer, [community, user], guard);
        return (
          guard.isCurrent?.() !== false &&
          roster.filter((row) => row.member_id === user).length === 1 &&
          roster.filter((row) => row.member_id === community).length === 1
        );
      } catch {
        return false;
      }
    },
  });
}
