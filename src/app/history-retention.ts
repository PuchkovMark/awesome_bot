import type { createVkChannel } from '../channels/vk/channel';
import { isVkGroupChat, vkChatId, type VkIncoming } from '../channels/vk/normalize';
import type { AuthorizationContext, ChatId, IncomingMessage, UserId } from '../contracts/index';
import { parseHistoryCommand } from '../core/history-retention/commands';
import { createHistoryClearService } from '../core/history-retention/service';
import type { createAuthorizationService } from '../core/authorization/service';
import type { createLifecycleService } from '../core/lifecycle/service';
import { chatControlStore } from '../storage/chat-control-store';
import type { Storage } from '../storage/index';

export function createHistoryHandlers(options: {
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
  readonly isRunning: () => boolean;
  readonly wakeMaintenance: () => void;
}) {
  const { authorization, lifecycle, channel, ownerId, group, signal } = options;
  const service = createHistoryClearService(options);
  const controls = chatControlStore(options.storage);
  return {
    recognize(message: IncomingMessage) {
      if (!message.isGroupChat || message.isBot !== false) return null;
      const command = parseHistoryCommand(message.text, 'group');
      return command
        ? ({
            action: 'chat.history.clear',
            minimumRole: 'admin',
            replayRequest: command.kind === 'request',
          } as const)
        : null;
    },
    async execute(
      context: AuthorizationContext,
      message: IncomingMessage,
      current: () => boolean,
      replayOnly = false,
    ) {
      const command = parseHistoryCommand(message.text, 'group');
      if (!command) return;
      const isCurrent = () =>
        options.isRunning() && current() && controls.read(context.scope).enabled;
      const reply = await service.handle(
        context,
        message.chatId,
        message.messageId,
        command,
        isCurrent,
        replayOnly,
      );
      if (reply)
        await channel.replyGroupControl(context.scope, reply, {
          signal,
          isCurrent,
          async allow() {
            return (
              isCurrent() && (await authorization.check(context, 'chat.history.clear')).allowed
            );
          },
        });
    },
    privateCommand(message: VkIncoming, current: () => boolean) {
      if (isVkGroupChat(message.peerId)) return undefined;
      const command = parseHistoryCommand(message.text, 'private');
      if (!command) return undefined;
      const sender = vkChatId(message.authorId);
      if (
        sender !== ownerId ||
        message.peerId !== message.authorId ||
        message.authorId <= 0 ||
        message.isMentioned ||
        message.reply ||
        command.kind === 'invalid'
      )
        return Promise.resolve();
      return (async () => {
        const target =
          command.kind === 'request'
            ? command.target
            : service.privateTarget(
                { origin: sender, initiator: sender, owner: true },
                command.code,
              );
        if (!target || !group(target.chatId)) return;
        const scope = lifecycle.admissionScope(target.chatId);
        if (scope.generation !== target.generation) return;
        const isCurrent = () =>
          !signal.aborted &&
          current() &&
          options.isRunning() &&
          lifecycle.isAdmissionCurrent(scope);
        const context = authorization.context({ scope, userId: sender, kind: 'owner' });
        const reply = await service.handle(
          context,
          sender,
          String(message.cmid),
          command,
          isCurrent,
        );
        if (reply)
          await channel.replyPrivateControl(sender, reply, {
            signal,
            isCurrent,
            allow: async () => isCurrent(),
          });
      })();
    },
  };
}
