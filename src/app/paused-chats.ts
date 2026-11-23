import type { createVkChannel } from '../channels/vk/channel';
import { isVkGroupChat, vkChatId, type VkIncoming } from '../channels/vk/normalize';
import { vkLocalId } from '../channels/vk/outbound';
import { vkMessageLength } from '../channels/vk/outbound-text';
import type {
  ConnectionPauseReason,
  ConnectionVersion,
  PausedConnection,
  UserId,
} from '../contracts/index';
import type { createLifecycleService } from '../core/index';
import { StorageError } from '../storage/errors';

const listCommand = 'приостановленные беседы';
const reasonText: Record<ConnectionPauseReason, string> = {
  startup: 'После запуска приложения непрерывность приёма не подтверждена.',
  observation_lost: 'Прервалось наблюдение за событиями VK. Непрерывность приёма не подтверждена.',
  first_seen: 'Подключение обнаружено впервые.',
  membership_signal: 'VK сообщил о возможной смене подключения сообщества.',
  verification_uncertain: 'Сверка не подтвердила состояние подключения.',
};

type Command =
  | { readonly kind: 'list' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'continue' | 'new'; readonly selected: ConnectionVersion };

function parseCommand(text: string): Command | undefined {
  const clean = text.trim().toLowerCase();
  if (clean === listCommand) return { kind: 'list' };
  if (clean.startsWith(listCommand) && /^\s/u.test(clean.slice(listCommand.length)))
    return { kind: 'invalid' };

  const verb = /^(продолжить|начать[ \t]+заново)(?=\s|$)/u.exec(clean)?.[0];
  if (!verb) return undefined;
  const tail = clean.slice(verb.length);
  const targetText = tail.trim();
  if (targetText && !/^(?:[a-z][a-z0-9_-]*:|vk(?:\s|$)|-?\d)/u.test(targetText)) return undefined;
  const target = /^[ \t]+(vk:-?[1-9]\d*)[ \t]+([1-9]\d*)\/(0|[1-9]\d*)$/u.exec(tail);
  if (!target) return { kind: 'invalid' };
  const peer = vkLocalId(target[1]!);
  const generation = Number(target[2]);
  const revision = Number(target[3]);
  if (peer === undefined || !Number.isSafeInteger(generation) || !Number.isSafeInteger(revision))
    return { kind: 'invalid' };
  return {
    kind: verb === 'продолжить' ? 'continue' : 'new',
    selected: { chatId: vkChatId(peer), generation, revision },
  };
}

function formatOverview(overview: readonly PausedConnection[]): readonly string[] {
  if (overview.length === 0) return ['Приостановленных бесед нет.'];
  const header = 'Приостановленные беседы VK';
  const parts: string[] = [];
  let part = header;
  for (const { chatId, generation, revision, reason } of overview) {
    const binding = `${chatId} ${generation}/${revision}`;
    const row = [
      `Беседа ${chatId}. ${reason ? reasonText[reason] : 'Причина прежней паузы не сохранена.'}`,
      `Продолжить ${binding}`,
      'Сохраняет текущую историю и настройки. Сообщения за время паузы могут отсутствовать.',
      `Начать заново ${binding}`,
      'Удаляет данные прежнего подключения и начинает настройку заново.',
    ].join('\n');
    const next = `\n\n${row}`;
    if (Buffer.byteLength(part + next) > vkMessageLength.value) {
      parts.push(part);
      part = header;
    }
    part += next;
  }
  parts.push(part);
  return parts;
}

export function createPausedChatCommands(options: {
  readonly channel: Pick<ReturnType<typeof createVkChannel>, 'replyPrivateControl'>;
  readonly lifecycle: Pick<
    ReturnType<typeof createLifecycleService>,
    'pausedConnections' | 'decidePaused'
  >;
  readonly ownerId: UserId;
  readonly signal: AbortSignal;
}) {
  const { channel, lifecycle, ownerId, signal } = options;

  async function handle(command: Command, sender: UserId, current: () => boolean) {
    const isCurrent = () => !signal.aborted && current();
    if (!isCurrent()) return;
    const guard = { signal, isCurrent, allow: async () => isCurrent() };
    if (command.kind === 'list') {
      for (const part of formatOverview(lifecycle.pausedConnections('vk', sender))) {
        if (!isCurrent()) break;
        await channel.replyPrivateControl(sender, part, guard);
      }
      return;
    }
    if (command.kind === 'invalid') {
      await channel.replyPrivateControl(
        sender,
        'Скопируйте целую команду из списка «Приостановленные беседы».',
        guard,
      );
      return;
    }
    const { kind, selected } = command;
    let outcome: string;
    try {
      lifecycle.decidePaused(selected, sender, kind);
      outcome =
        kind === 'continue'
          ? `Беседа ${selected.chatId} продолжена. История и настройки сохранены.`
          : `Для беседы ${selected.chatId} начато новое подключение. Данные прежнего подключения удалены.`;
    } catch (error) {
      if (!(error instanceof StorageError && error.code === 'stale_scope')) throw error;
      outcome = `Состояние беседы ${selected.chatId} изменилось. Обновите список командой «Приостановленные беседы».`;
    }
    await channel.replyPrivateControl(sender, outcome, guard);
  }

  return (message: VkIncoming, isCurrent: () => boolean): Promise<void> | undefined => {
    const command = parseCommand(message.text);
    if (!command) return undefined;
    const sender = vkChatId(message.authorId);
    if (
      sender !== ownerId ||
      message.peerId !== message.authorId ||
      message.authorId <= 0 ||
      isVkGroupChat(message.peerId) ||
      message.isMentioned ||
      message.hasReply ||
      message.reply ||
      message.hasForwarded
    )
      return Promise.resolve();
    return handle(command, sender, isCurrent);
  };
}
