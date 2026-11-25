import type { createVkChannel } from '../channels/vk/channel';
import {
  isVkGroupChat,
  isVkGroupChatId,
  vkChatId,
  vkCmid,
  type VkIncoming,
} from '../channels/vk/normalize';
import { vkLocalId } from '../channels/vk/outbound';
import type {
  AuthorizationContext,
  ChatId,
  ConnectionScope,
  IncomingMessage,
  UserId,
} from '../contracts/index';
import {
  deny,
  type AdminCommand,
  type AdminCommandResult,
  type AuthorizationResult,
  type createAuthorizationService,
} from '../core/authorization/service';
import type { createLifecycleService } from '../core/lifecycle/service';
import type { ServiceCommand } from '../core/message-router/types';
import { chatControlStore, type ControlMessageEvent } from '../storage/chat-control-store';
import { StorageError } from '../storage/errors';
import type { RevocationAudit, Storage } from '../storage/index';

const journalLabel = 'Команда управления администраторами бота';
const groupUsage =
  'Ответьте командой на сообщение человека или укажите один VK ID, например vk:42.';
const actions = {
  grant: 'admin.grant',
  remove: 'admin.remove',
  revoke: 'admin.revoke',
  audit: 'admin.audit.read',
  restore: 'admin.restore',
} as const;
const names = new Map<string, keyof typeof actions>([
  ['/назначить-админа', 'grant'],
  ['/снять-админа', 'remove'],
  ['/отозвать-админа', 'revoke'],
  ['/аудит-админа', 'audit'],
  ['/отменить-отзыв', 'restore'],
]);
type Request =
  | { readonly kind: 'grant' | 'remove' | 'restore'; readonly userId: UserId }
  | { readonly kind: 'revoke'; readonly userId: UserId; readonly reason: string };

function parseName(text: string) {
  const match = /^\s*(\/\S+)([\s\S]*)$/u.exec(text);
  if (!match?.[1]) return null;
  const name = match[1].toLowerCase();
  const kind = names.get(name);
  return kind ? { name, kind, rest: match[2] ?? '' } : null;
}

function humanId(value: string): UserId | undefined {
  const id = vkLocalId(value);
  if (id !== undefined && id > 0) return `vk:${id}`;
}

function privateTarget(parsed: NonNullable<ReturnType<typeof parseName>>) {
  const match = /^\s+(vk:\d+)@([1-9]\d*)\s+(\S+)(?:\s([\s\S]*))?$/u.exec(parsed.rest);
  if (!match?.[1] || !isVkGroupChatId(match[1]) || !match[3]) return null;
  const generation = Number(match[2]);
  const userId = humanId(match[3]);
  const reason = match[4] ?? '';
  if (!Number.isSafeInteger(generation) || !userId || (parsed.kind !== 'revoke' && reason.trim()))
    return null;
  return { chatId: match[1] as ChatId, generation, userId, reason };
}

function resultText(request: Request, result: AuthorizationResult<AdminCommandResult>): string {
  if (result.allowed) {
    switch (result.value.status) {
      case 'granted':
        return 'Обычное назначение выдано.';
      case 'existing':
        return request.kind === 'revoke'
          ? 'Отзыв уже действует.'
          : 'Обычное назначение уже действует.';
      case 'removed':
        return 'Обычное назначение снято.';
      case 'not_assigned':
        return 'Обычного назначения в этой беседе уже нет.';
      case 'revoked':
        return 'Все локальные основания отозваны. Аудит сохранён.';
      case 'restored':
        return 'Отзыв отменён. Для возврата обычных прав назначьте участника заново.';
      case 'not_revoked':
        return 'Действующего отзыва в этой беседе нет.';
      case 'duplicate':
        return 'Команда уже обработана.';
    }
  }
  switch (result.code) {
    case 'unconfirmed_member':
      return 'Не удалось подтвердить участие человека в этой беседе. Проверьте VK ID и повторите команду.';
    case 'protected':
      return 'У человека есть защищённое основание. Отозвать его может владелец бота из лички.';
    case 'revoked':
      return 'Для человека действует отзыв владельца. Владелец может отменить его из лички.';
    case 'invalid_reason':
      return 'Укажите непустую причину отзыва после VK ID участника.';
    case 'reason_too_long':
      return `Причина превышает предел в ${result.maxLength} символов. Сократите её и повторите команду.`;
    case 'conflict':
      if (request.kind === 'revoke')
        return 'У человека нет защищённого основания. Для обычного назначения используйте /снять-админа.';
      return 'Действие отклонено. Проверьте подключение и полномочия.';
    default:
      return 'Действие отклонено. Проверьте подключение и полномочия.';
  }
}

function targetText(scope: ConnectionScope, userId: UserId, text: string) {
  return `${scope.chatId}@${scope.generation} · ${userId}\n${text}`;
}

function auditText(audit: RevocationAudit | null) {
  if (!audit) return 'Аудита отзыва для этого человека в беседе нет.';
  const bases = {
    creator: 'создатель беседы',
    inviter: 'пригласивший бота',
    explicit: 'обычное назначение',
  };
  return [
    `Отзыв от ${new Date(audit.revokedAt).toISOString()}`,
    `Владелец ${audit.revokedBy}`,
    `Сняты основания — ${audit.bases.map((basis) => bases[basis]).join(', ')}.`,
    audit.reason === null ? 'Срок хранения причины истёк.' : `Причина отзыва\n${audit.reason}`,
  ].join('\n');
}

export function createBotAdminCommands(options: {
  readonly storage: Storage;
  readonly authorization: Awaited<ReturnType<typeof createAuthorizationService>>;
  readonly lifecycle: ReturnType<typeof createLifecycleService>;
  readonly channel: Pick<
    ReturnType<typeof createVkChannel>,
    'administrationEvidence' | 'replyGroupControl' | 'replyPrivateControl'
  >;
  readonly disclosureVersion: (scope: ConnectionScope) => number | null;
  readonly ownerId: UserId;
  readonly reasonRetentionMs: number;
  readonly signal: AbortSignal;
  readonly track: import('./control-publications').TrackPublication;
}) {
  const { storage, authorization, lifecycle, channel, disclosureVersion, signal } = options;
  const controls = chatControlStore(storage);

  function activeScope(chatId: ChatId, pinned: boolean) {
    try {
      return pinned ? lifecycle.admissionScope(chatId) : lifecycle.current(chatId);
    } catch (error) {
      if (
        !(error instanceof StorageError) ||
        !['stale_scope', 'uncertain_connection', 'closed'].includes(error.code)
      )
        throw error;
      return undefined;
    }
  }

  async function change(
    observed: ConnectionScope,
    actor: Pick<AuthorizationContext, 'kind' | 'userId'>,
    request: Request,
    event: ControlMessageEvent,
    current: () => boolean,
  ): Promise<AuthorizationResult<AdminCommandResult> | undefined> {
    if (!current()) return;
    let command: AdminCommand;
    if (request.kind === 'grant') {
      const present = await channel.administrationEvidence.hasMember(observed, request.userId, {
        signal,
        isCurrent: current,
      });
      if (!current()) return;
      if (!present) return deny('unconfirmed_member');
      const membership = await authorization.confirmMembership(observed, request.userId);
      command = { kind: 'grant', userId: request.userId, membership };
    } else if (request.kind === 'revoke') {
      command = request;
    } else {
      command = { kind: request.kind, userId: request.userId };
    }
    if (!current()) return;
    const scope = activeScope(observed.chatId, false);
    if (!scope || scope.generation !== observed.generation) return;
    const context = authorization.context({ scope, kind: actor.kind, userId: actor.userId });
    return authorization.executeAdminCommand(context, command, event, current);
  }

  async function scopeAfterChange(scope: ConnectionScope, revision: number) {
    const latest = activeScope(scope.chatId, true);
    if (!latest || latest.generation !== scope.generation) return;
    try {
      if (await storage.authorization.transaction(latest, (tx) => tx.revision() === revision))
        return latest;
    } catch (error) {
      if (!(error instanceof StorageError) || error.code !== 'stale_scope') throw error;
    }
  }

  return {
    recognizeGroup(message: IncomingMessage): ServiceCommand | null {
      if (!message.isGroupChat) return null;
      const request = parseName(message.text);
      if (!request) return null;
      return {
        action: actions[request.kind],
        minimumRole: request.kind === 'grant' || request.kind === 'remove' ? 'admin' : 'owner',
        journalLabel,
      };
    },
    async executeGroup(
      context: AuthorizationContext,
      message: IncomingMessage,
      accepted: () => boolean,
      isObserving: () => boolean,
    ) {
      const parsed = parseName(message.text);
      if (!parsed || (parsed.kind !== 'grant' && parsed.kind !== 'remove') || !accepted()) return;
      const scope = context.scope;
      const received = controls.read(scope);
      const version = disclosureVersion(scope);
      const current = () => {
        if (signal.aborted || !accepted()) return false;
        const state = controls.read(scope);
        return state.enabled && state.responseRevision === received.responseRevision;
      };
      const reply = (text: string) =>
        options.track(
          channel.replyGroupControl(scope, text, {
            signal,
            isCurrent: current,
            allow: async () => current(),
          }),
        );
      if (!current() || version === null || message.isBot !== false) return;
      const replyGiven =
        message.replyAddress !== undefined || message.replyToMessageId !== undefined;
      const argument = parsed.rest.trim();
      const repliedUser = message.replyToMessageId ? message.replyAuthorId : undefined;
      const userId = humanId(argument || repliedUser || '');
      if (
        !userId ||
        (argument && replyGiven) ||
        message.hasForwarded ||
        message.hasOtherAddress ||
        message.attachments.length
      ) {
        reply(groupUsage);
        return;
      }
      const messageId = vkCmid(Number(message.messageId));
      if (messageId === undefined || String(messageId) !== message.messageId) return;
      const request = { kind: parsed.kind, userId };
      const result = await change(
        scope,
        context,
        request,
        {
          sourceChatId: message.chatId,
          messageId,
          timestamp: message.timestamp,
        },
        current,
      );
      if (!result) return;
      const text = targetText(scope, userId, resultText(request, result));
      if (!result.allowed) {
        reply(text);
        return;
      }
      if (!isObserving()) return;
      const latest = await scopeAfterChange(scope, result.value.revision);
      if (!latest) return;
      const publish = () => {
        if (signal.aborted || !isObserving() || !lifecycle.isAdmissionCurrent(latest)) return false;
        const state = controls.read(latest);
        return (
          state.enabled &&
          state.responseRevision === received.responseRevision &&
          disclosureVersion(latest) === version
        );
      };
      options.track(
        channel.replyGroupControl(latest, text, {
          signal,
          isCurrent: publish,
          allow: async () => publish(),
        }),
      );
    },
    privateCommand(message: VkIncoming, isObserving: () => boolean): Promise<void> | undefined {
      if (isVkGroupChat(message.peerId)) return undefined;
      const parsed = parseName(message.text);
      if (!parsed) return undefined;
      const sender = vkChatId(message.authorId);
      if (
        sender !== options.ownerId ||
        message.authorId <= 0 ||
        message.peerId !== message.authorId ||
        message.isMentioned ||
        message.hasOtherAddress ||
        message.hasReply ||
        message.reply ||
        message.hasForwarded ||
        message.attachments.length
      )
        return Promise.resolve();
      return (async () => {
        const origin = () => !signal.aborted && isObserving();
        if (!origin()) return;
        const replyFromOwner = (text: string) =>
          channel.replyPrivateControl(sender, text, {
            signal,
            isCurrent: origin,
            allow: async () => origin(),
          });
        const target = privateTarget(parsed);
        if (!target) {
          const example = `${parsed.name} vk:2000000041@7 vk:42${parsed.kind === 'revoke' ? ' Причина отзыва' : ''}`;
          await replyFromOwner(
            `Укажите беседу, поколение и VK ID человека. ID подключения показывает /настройки.\n${example}`,
          );
          return;
        }
        const observed = activeScope(target.chatId, true);
        if (!observed || observed.generation !== target.generation) {
          await replyFromOwner(
            'Беседа или поколение недоступны. Проверьте состояние подключения и ID в /настройки.',
          );
          return;
        }
        const current = () => origin() && lifecycle.isAdmissionCurrent(observed);
        if (parsed.kind === 'audit') {
          const context = authorization.context({ scope: observed, kind: 'owner', userId: sender });
          const result = await authorization.audit(context, target.userId);
          if (!current()) return;
          if (!result.allowed) {
            await replyFromOwner('Аудит недоступен. Проверьте состояние подключения.');
            return;
          }
          const audit = result.value;
          const stillValid = () =>
            current() &&
            (!audit ||
              audit.reason === null ||
              Date.now() < audit.revokedAt + options.reasonRetentionMs);
          const expected = JSON.stringify(audit);
          await channel.replyPrivateControl(
            sender,
            targetText(observed, target.userId, auditText(audit)),
            {
              signal,
              isCurrent: stillValid,
              async allow() {
                if (!stillValid()) return false;
                const fresh = await authorization.audit(context, target.userId);
                return stillValid() && fresh.allowed && JSON.stringify(fresh.value) === expected;
              },
            },
          );
          return;
        }
        const request: Request =
          parsed.kind === 'revoke'
            ? { kind: 'revoke', userId: target.userId, reason: target.reason }
            : { kind: parsed.kind, userId: target.userId };
        const result = await change(
          observed,
          { userId: sender, kind: 'owner' },
          request,
          {
            sourceChatId: vkChatId(message.peerId),
            messageId: message.cmid,
            timestamp: message.timestamp,
          },
          current,
        );
        if (!result) return;
        const latest = result.allowed
          ? await scopeAfterChange(observed, result.value.revision)
          : observed;
        if (!latest) return;
        const publish = () => origin() && lifecycle.isAdmissionCurrent(latest);
        const context = authorization.context({ scope: latest, kind: 'owner', userId: sender });
        await channel.replyPrivateControl(
          sender,
          targetText(latest, target.userId, resultText(request, result)),
          {
            signal,
            isCurrent: publish,
            async allow() {
              return (
                publish() &&
                (await authorization.check(context, actions[request.kind], target.userId))
                  .allowed &&
                publish()
              );
            },
          },
        );
      })();
    },
  };
}
