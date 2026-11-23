import type { createVkChannel } from '../channels/vk/channel';
import { isVkGroupChat, vkChatId, type VkIncoming } from '../channels/vk/normalize';
import type { UserId } from '../contracts/index';
import type { createTokenBudgetAdministration } from '../core/index';

export const isUsageCommand = (text: string) => text.trim().toLowerCase() === 'показать расход';

type Overview = Extract<
  ReturnType<ReturnType<typeof createTokenBudgetAdministration>['overview']>,
  { allowed: true }
>['value'];

function formatOverview(overview: Overview) {
  const from = new Date(overview.period.from).toISOString();
  const until = new Date(overview.period.through).toISOString();
  const window = `Расход за 24 часа (UTC)\n${from} — ${until}`;
  const describe = (balance: Overview['chats'][number]['total']) =>
    `подтверждено ${balance.confirmed} из ${balance.limit}, удержано ${balance.reserved}, попыток без полного usage ${balance.incompleteAttempts}`;

  if (overview.chats.length === 0) return `${window}\nБесед пока нет.`;
  return [
    window,
    ...overview.chats.map(({ chatId, total, initiative }) =>
      [
        `${chatId} — ${describe(total)}.`,
        ...(initiative ? [`Инициатива — ${describe(initiative)}.`] : []),
      ].join('\n'),
    ),
  ].join('\n');
}

export function createUsageCommand(options: {
  readonly channel: Pick<ReturnType<typeof createVkChannel>, 'replyPrivateControl'>;
  readonly ownerId: UserId;
  readonly signal: AbortSignal;
  readonly budget: ReturnType<typeof createTokenBudgetAdministration>;
}) {
  return (message: VkIncoming, current: () => boolean): Promise<void> | undefined => {
    if (!isUsageCommand(message.text) || isVkGroupChat(message.peerId)) return undefined;
    const sender = vkChatId(message.authorId);
    if (
      sender !== options.ownerId ||
      message.peerId !== message.authorId ||
      message.authorId <= 0 ||
      message.isMentioned ||
      message.hasReply ||
      message.reply
    )
      return Promise.resolve();

    const isCurrent = () => !options.signal.aborted && current();
    if (!isCurrent()) return Promise.resolve();
    const result = options.budget.overview(sender);
    if (!result.allowed) return Promise.resolve();
    return options.channel.replyPrivateControl(sender, formatOverview(result.value), {
      signal: options.signal,
      isCurrent,
      allow: async () => isCurrent(),
    });
  };
}
