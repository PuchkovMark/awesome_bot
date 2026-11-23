import type { createVkChannel } from '../channels/vk/channel';
import { isVkGroupChat, type VkIncoming } from '../channels/vk/normalize';
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
    'replyPrivateControl' | 'replyGroupControl'
  >;
  readonly ownerId: UserId;
  readonly group: (chatId: ChatId) => boolean;
  readonly signal: AbortSignal;
}) {
  const { authorization, lifecycle, channel, ownerId, signal } = options;
  const controls = chatControlStore(options.storage);
  const diagnostics = createTraceDiagnostics({ storage: options.storage, authorization });

  return {
    recognize(message: IncomingMessage, replyToOther?: boolean) {
      if (!message.isGroupChat || message.isBot !== false) return null;
      const request = parseChatControl(message.text, 'group');
      if (!request) return null;
      if (typeof request.command === 'string')
        return { action: 'chat.configure', minimumRole: 'admin' } as const;
      if (request.command.kind === 'pause' && replyToOther) return null;
      if (request.command.kind === 'greeting' && (replyToOther || message.hasForwarded))
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
      const messageId = command.kind === 'greeting' ? Number(message.messageId) : undefined;
      if (
        messageId !== undefined &&
        (!Number.isSafeInteger(messageId) ||
          messageId < 1 ||
          String(messageId) !== message.messageId)
      )
        return;
      const result = await authorization.controlChat(context, command, isCurrent, messageId);
      if (!result.allowed || !result.value.state.enabled) return;
      const reply = formatChatControl(context.scope, command, result.value, Date.now());
      if (reply)
        await channel.replyGroupControl(context.scope, reply, {
          signal,
          isCurrent: () => isCurrent() && controls.read(context.scope).enabled,
          async allow() {
            if (!isCurrent()) return false;
            return (await authorization.check(context, chatControlAction(command).action)).allowed;
          },
        });
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
      const sender = `vk:${message.authorId}` as const;
      const command = request.command;
      if (command !== 'explain' && sender !== ownerId) return Promise.resolve();
      return (async () => {
        const target = request.target;
        if (!target || !options.group(target.chatId) || command === 'invalid') return;
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
        const result = await authorization.controlChat(context, command, isCurrent, message.cmid);
        if (!result.allowed) return;
        const reply = formatChatControl(scope, command, result.value, Date.now());
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
