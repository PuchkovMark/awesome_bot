import { createQuestionnaireEditor } from './questionnaire-editor';
import type { createVkChannel } from '../channels/vk/channel';
import { isVkGroupChat, vkChatId, type VkIncoming } from '../channels/vk/normalize';
import type { AuthorizationContext, ChatId, IncomingMessage, UserId } from '../contracts/index';
import { chatControlAction, parseChatControl } from '../core/chat-control/commands';
import { formatChatControl } from '../core/chat-control/service';
import type { createAuthorizationService } from '../core/authorization/service';
import type { createLifecycleService } from '../core/lifecycle/service';
import { createTraceDiagnostics } from '../core/response-tracing/diagnostics';
import { chatControlStore } from '../storage/chat-control-store';
import type { Storage } from '../storage/index';

export function createChatControlHandlers(options: {
  readonly storage: Storage;
  readonly authorization: Awaited<ReturnType<typeof createAuthorizationService>>;
  readonly lifecycle: ReturnType<typeof createLifecycleService>;
  readonly channel: Pick<
    ReturnType<typeof createVkChannel>,
    'replyPrivateControl' | 'replyGroupControl' | 'deliverGroupControl'
  >;
  readonly ownerId: UserId;
  readonly group: (chatId: ChatId) => boolean;
  readonly signal: AbortSignal;
  readonly track: (work: Promise<unknown>) => void;
}) {
  const { authorization, lifecycle, channel, ownerId, signal } = options;
  const controls = chatControlStore(options.storage);
  const questionnaire = createQuestionnaireEditor(options);
  const diagnostics = createTraceDiagnostics({ storage: options.storage, authorization });

  return {
    editor: questionnaire,
    recognize(message: IncomingMessage, replyToOther?: boolean) {
      if (!message.isGroupChat || message.isBot !== false) return null;
      const request = parseChatControl(message.text, 'group');
      if (!request) return null;
      if (typeof request.command === 'string')
        return { action: 'chat.configure', minimumRole: 'admin' } as const;
      if (request.command.kind === 'pause' && replyToOther) return null;
      if (
        ['greeting', 'invitation', 'greetingHelp', 'invitationHelp'].includes(
          request.command.kind,
        ) &&
        (replyToOther || message.hasForwarded)
      )
        return null;
      return chatControlAction(request.command);
    },
    async execute(
      context: AuthorizationContext,
      message: IncomingMessage,
      isCurrent: () => boolean,
    ) {
      const request = parseChatControl(message.text, 'group');
      if (!request || typeof request.command === 'string') return;
      const command = request.command;
      if (command.kind === 'questionnaire' || command.kind === 'questionnaireEdit')
        return questionnaire.show(
          context,
          message,
          isCurrent,
          command.kind === 'questionnaireEdit',
        );
      const messageId =
        command.kind === 'greeting' || command.kind === 'invitation' || command.kind === 'off'
          ? Number(message.messageId)
          : undefined;
      if (
        messageId !== undefined &&
        (!Number.isSafeInteger(messageId) ||
          messageId < 1 ||
          String(messageId) !== message.messageId)
      )
        return;
      const event =
        messageId === undefined
          ? undefined
          : { sourceChatId: message.chatId, messageId, timestamp: message.timestamp };
      const result = await authorization.controlChat(context, command, isCurrent, event);
      if (!result.allowed || !result.value.state.enabled) return;
      const reply = formatChatControl(context.scope, command, result.value, Date.now());
      if (reply) {
        const current = () => {
          if (!isCurrent()) return false;
          const latest = controls.read(context.scope);
          return latest.enabled && latest.responseRevision === result.value.state.responseRevision;
        };
        if (
          command.kind === 'invitation' &&
          command.enabled &&
          result.value.state.invitationEnabledAt !== null
        )
          return questionnaire.confirmInvitation(
            context,
            () => current() && controls.read(context.scope).invitationEnabledAt !== null,
          );
        options.track(
          channel.replyGroupControl(context.scope, reply, {
            signal,
            isCurrent: current,
            async allow() {
              return (
                current() &&
                (await authorization.check(context, chatControlAction(command).action)).allowed &&
                current()
              );
            },
          }),
        );
      }
    },
    privateCommand(message: VkIncoming, current: () => boolean) {
      if (isVkGroupChat(message.peerId)) return undefined;
      const request = parseChatControl(message.text, 'private');
      if (!request) return undefined;
      if (
        message.peerId !== message.authorId ||
        message.authorId <= 0 ||
        message.isMentioned ||
        message.reply
      )
        return Promise.resolve();
      const sender = vkChatId(message.authorId);
      const command = request.command;
      if (command !== 'explain' && sender !== ownerId) return Promise.resolve();
      return (async () => {
        const target = request.target;
        if (!target || command === 'invalid' || !current() || signal.aborted) return;
        const toggle = command !== 'explain' && (command.kind === 'on' || command.kind === 'off');
        if (toggle && message.hasForwarded) return;
        if (!options.group(target.chatId) && !(toggle && /^vk:[1-9]\d*$/.test(target.chatId)))
          return;
        const pausedEnabled =
          toggle && sender === ownerId
            ? lifecycle.setPausedEnabled(target, sender, command.kind === 'on', {
                sourceChatId: sender,
                messageId: message.cmid,
                timestamp: message.timestamp,
              })
            : undefined;
        if (pausedEnabled !== undefined) {
          await channel.replyPrivateControl(
            sender,
            pausedEnabled ? 'Бот включён.' : 'Бот выключен.',
            {
              signal,
              isCurrent: current,
              allow: async () => current(),
            },
          );
          return;
        }
        const scope = lifecycle.admissionScope(target.chatId);
        if (scope.generation !== target.generation) return;
        const state = controls.read(scope);
        const isCurrent = () => {
          if (signal.aborted || !current() || !lifecycle.isAdmissionCurrent(scope)) return false;
          if (sender === ownerId) return true;
          const latest = controls.read(scope);
          return latest.enabled && latest.responseRevision === state.responseRevision;
        };
        if (!isCurrent()) return;
        const context = authorization.context({
          scope,
          userId: sender,
          kind: sender === ownerId ? 'owner' : 'chat',
        });
        if (command === 'explain') {
          const result = await diagnostics.explain(context);
          if (!result.allowed) return;
          const answer = result.value;
          await channel.replyPrivateControl(
            sender,
            answer?.text ?? 'В этой беседе нет доступной сводки доставленного ответа.',
            {
              signal,
              isCurrent,
              async allow() {
                if (!isCurrent()) return false;
                if (!answer)
                  return (await authorization.check(context, 'diagnostics.read')).allowed;
                const fresh = await diagnostics.explain(context, answer.jobId);
                return fresh.allowed && fresh.value !== null;
              },
            },
          );
          return;
        }
        const result = await authorization.controlChat(context, command, isCurrent, {
          sourceChatId: vkChatId(message.peerId),
          messageId: message.cmid,
          timestamp: message.timestamp,
        });
        if (!result.allowed) return;
        const reply =
          command.kind === 'invitation' &&
          command.enabled &&
          result.value.state.invitationEnabledAt !== null
            ? questionnaire.invitationPrivate(scope)
            : formatChatControl(scope, command, result.value, Date.now(), true);
        if (reply)
          await channel.replyPrivateControl(sender, reply, {
            signal,
            isCurrent,
            async allow() {
              return isCurrent();
            },
          });
      })();
    },
  };
}
