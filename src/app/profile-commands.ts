import type { ChatId, ConnectionScope, IncomingMessage, UserId } from '../contracts/index';
import type { createVkChannel } from '../channels/vk/channel';
import { isVkGroupChat, vkChatId, type VkIncoming } from '../channels/vk/normalize';
import { vkLocalId } from '../channels/vk/outbound';
import type { createAuthorizationService } from '../core/authorization/service';
import type { createChatOnboarding } from '../core/chat-onboarding/service';
import type { createLifecycleService } from '../core/lifecycle/service';
import { StorageError } from '../storage/errors';
import type { personalDataStore } from '../storage/personal-data-store';
import { profileCommandStore } from '../storage/profile-command-store';
import type { ProfileCommandChange, ProfileCommandEvent } from '../storage/profile-command-types';
import type { Storage } from '../storage/types';
import { profileListText } from './profile-list-text';

const show = /^\/профиль(?:\s+(vk:[1-9]\d*))?$/iu;
const prefix = /^\/(профиль|исправить|скрыть|отклонить)(?=\s|$)/iu;
const edit = /^\/(исправить|скрыть|отклонить)\s+([1-9]\d*)(?:\s+([\s\S]+))?$/iu;
const retry = 'Откройте /профиль заново и ответьте на сообщение списка.';
function deliveryHint(chat: string) {
  return `Откройте личный диалог с сообществом и отправьте /профиль ${chat}`;
}
const serviceCommand = {
  action: 'profile.self.manage',
  minimumRole: 'member',
  journalLabel: 'Личная команда профиля',
} as const;

function parseEdit(text: string): { position: number; change: ProfileCommandChange } | null {
  const match = edit.exec(text);
  if (!match) return null;
  const position = Number(match[2]);
  if (!Number.isSafeInteger(position)) return null;
  const value = match[3]?.trim();
  switch (match[1]?.toLowerCase()) {
    case 'исправить':
      return value && !value.includes('\0')
        ? { position, change: { kind: 'correct', value } }
        : null;
    case 'скрыть':
      return value ? null : { position, change: { kind: 'hide' } };
    case 'отклонить':
      return value ? null : { position, change: { kind: 'reject' } };
    default:
      return null;
  }
}

export function createProfileCommands(options: {
  storage: Storage;
  authorization: Awaited<ReturnType<typeof createAuthorizationService>>;
  privacy: ReturnType<typeof personalDataStore>;
  channel: Pick<
    ReturnType<typeof createVkChannel>,
    'reminderDelivery' | 'verifiedProfileReply' | 'replyGroupControl' | 'replyPrivateControl'
  >;
  lifecycle: ReturnType<typeof createLifecycleService>;
  onboarding: ReturnType<typeof createChatOnboarding>;
  signal: AbortSignal;
  track: import('./control-publications').TrackPublication;
}) {
  const { storage, authorization, privacy, channel, lifecycle, onboarding, signal } = options;
  const lists = profileCommandStore(storage);
  const views = new Map<UserId, symbol>();
  const pending = new Set<string>();
  const active = (scope: ConnectionScope) => !signal.aborted && lifecycle.isAdmissionCurrent(scope);
  const guard = (current: () => boolean) => ({
    signal,
    isCurrent: current,
    allow: async () => current(),
  });

  async function directScope(actor: UserId, current: () => boolean) {
    let scope: ConnectionScope;
    try {
      scope = lifecycle.admissionScope(actor);
    } catch (error) {
      if (!(error instanceof StorageError) || error.code !== 'stale_scope') return null;
      if (!(await channel.reminderDelivery(actor).canWrite(guard(current))) || !current())
        return null;
      await lifecycle.verify(actor);
      try {
        scope = lifecycle.admissionScope(actor);
      } catch {
        return null;
      }
    }
    if (!current() || !active(scope)) return null;
    await storage.chats.create(scope, {
      enabled: true,
      responseMode: 'normal',
      createdAt: Date.now(),
    });
    return current() && active(scope) ? scope : null;
  }

  async function view(
    target: ConnectionScope,
    actor: UserId,
    event: ProfileCommandEvent,
    current: () => boolean,
    groupOrigin: boolean,
  ) {
    const inTarget = () => current() && active(target) && privacy.hasData(target, actor);
    const eventKey = JSON.stringify([event.scope.chatId, event.scope.generation, event.messageId]);
    if (!inTarget() || pending.has(eventKey) || lists.seen(event, Date.now())) return;
    pending.add(eventKey);
    const opening = Symbol();
    views.set(actor, opening);
    const latest = () => views.get(actor) === opening && inTarget();
    const finish = () => {
      pending.delete(eventKey);
      if (views.get(actor) === opening) views.delete(actor);
    };
    let publishing = false;
    const publish = (work: Promise<void>) => {
      publishing = true;
      options.track(work.finally(finish));
    };
    try {
      const context = authorization.context({ scope: target, userId: actor });
      if (!(await authorization.check(context, 'profile.self.manage', actor)).allowed || !latest())
        return;
      const hint = () =>
        channel.replyGroupControl(target, deliveryHint(target.chatId), guard(latest));
      const privateScope = await directScope(actor, latest);
      if (!privateScope) {
        if (groupOrigin && latest()) publish(hint());
        return;
      }
      const list = lists.open(actor, privateScope, target, event, Date.now());
      if (!list) return;
      const prepared = profileListText(list);
      const parts = lists.parts(list, prepared, Date.now());
      if (!parts) return;
      const selected = () => {
        try {
          return latest() && active(privateScope) && lists.current(list, Date.now());
        } catch {
          return false;
        }
      };
      const endpoint = channel.reminderDelivery(actor);
      publish(
        (async () => {
          for (const [index, part] of parts.entries()) {
            if (!selected()) return;
            let receipt: string | undefined;
            const result = await endpoint.publish(
              prepared[index]!.text,
              part.sendId,
              (id) => {
                receipt = id;
              },
              guard(selected),
            );
            if (result !== 'delivered' || receipt === undefined) {
              if (result === 'failed' && index === 0 && groupOrigin && selected()) await hint();
              return;
            }
            if (
              !latest() ||
              !active(privateScope) ||
              !lists.confirm(list, part.number, part.sendId, receipt, Date.now())
            )
              return;
          }
        })(),
      );
    } finally {
      if (!publishing) finish();
    }
  }

  return {
    recognize(message: IncomingMessage) {
      return message.isGroupChat && prefix.test(message.text.trim()) ? serviceCommand : null;
    },
    async group(scope: ConnectionScope, message: IncomingMessage, current: () => boolean) {
      const parent = message.replyAddress !== undefined || message.replyToMessageId !== undefined;
      if (message.isBot !== false || message.hasForwarded) return;
      const args = show.exec(message.text.trim());
      if (!args || args[1] !== undefined || parent) {
        options.track(
          channel.replyGroupControl(
            scope,
            deliveryHint(args?.[1] ?? scope.chatId),
            guard(() => current() && active(scope)),
          ),
        );
        return;
      }
      await view(
        scope,
        message.userId,
        { scope, messageId: message.messageId, at: message.timestamp },
        current,
        true,
      );
    },
    private(message: VkIncoming, subscription: () => boolean) {
      if (isVkGroupChat(message.peerId) || !prefix.test(message.text.trim())) return undefined;
      if (message.peerId !== message.authorId || message.authorId <= 0 || message.hasForwarded)
        return Promise.resolve();
      return (async () => {
        const actor = vkChatId(message.authorId);
        const privateScope = await directScope(actor, subscription);
        if (!privateScope) return;
        const here = () => subscription() && active(privateScope);
        if (onboarding.configuredForProfiles() && onboarding.privatePending(privateScope))
          await onboarding.notifyPrivate(privateScope, here);
        if (!here()) return;
        const text = message.text.trim();
        const request = show.exec(text);
        if (request && !message.hasReply && !message.reply) {
          let target = privateScope;
          if (request[1] !== undefined && request[1] !== actor) {
            const id = vkLocalId(request[1]);
            if (id === undefined || !isVkGroupChat(id)) return;
            try {
              target = lifecycle.admissionScope(request[1] as ChatId);
            } catch (error) {
              if (!(error instanceof StorageError)) throw error;
              return;
            }
          }
          return view(
            target,
            actor,
            { scope: privateScope, messageId: String(message.cmid), at: message.timestamp },
            here,
            false,
          );
        }

        const parsed = parseEdit(text);
        const replyId =
          parsed && message.reply ? await channel.verifiedProfileReply(message, guard(here)) : null;
        const result =
          parsed && replyId && here()
            ? await authorization.editOwnProfile(
                authorization.context({ scope: privateScope, userId: actor }),
                { ...parsed, messageId: String(message.cmid), at: message.timestamp, replyId },
                here,
              )
            : null;
        const outcome = result?.allowed ? result.value : 'stale';
        if (outcome === 'duplicate' || !here()) return;
        const response =
          outcome === 'applied'
            ? 'Профиль обновлён.'
            : outcome === 'not_inferred'
              ? 'Отклонить можно только действующий вывод бота.'
              : outcome === 'conflict'
                ? 'Такой интерес уже есть в профиле.'
                : outcome === 'questionnaire'
                  ? 'Чтобы исправить ответ анкеты, отправьте /анкета изменить в беседе.'
                  : retry;
        await channel.replyPrivateControl(actor, response, guard(here));
      })();
    },
    prune: lists.prune,
  };
}
