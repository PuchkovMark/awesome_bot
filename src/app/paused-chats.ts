import { Keyboard } from 'vk-io';
import type { createVkChannel } from '../channels/vk/channel';
import { isVkGroupChat, vkChatId, vkRecord, type VkIncoming } from '../channels/vk/normalize';
import { vkLocalId } from '../channels/vk/outbound';
import { vkMessageLength } from '../channels/vk/outbound-text';
import type {
  ConnectionPauseReason,
  ConnectionVersion,
  PausedConnection,
  UserId,
} from '../contracts/index';
import type { createLifecycleService, PublicationGuard } from '../core/index';
import { StorageError } from '../storage/errors';

const listCommand = 'приостановленные беседы';
const overviewTitle = 'Приостановленные беседы VK';
const buttonLabels = { continue: 'Продолжить', new: 'Начать заново' } as const;
const reasonText: Record<ConnectionPauseReason, string> = {
  startup: 'На паузе после запуска бота.',
  observation_lost: 'Прервалось наблюдение за событиями VK. Непрерывность приёма не подтверждена.',
  first_seen: 'Подключение обнаружено впервые.',
  membership_signal: 'VK сообщил о возможной смене подключения сообщества.',
  verification_uncertain: 'Сверка не подтвердила состояние подключения.',
};

type Command =
  | { readonly kind: 'list' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'confirm' | 'cancel'; readonly code: string }
  | { readonly kind: 'continue' | 'new'; readonly selected: ConnectionVersion };

function parseCommand(text: string): Command | undefined {
  const clean = text.trim().toLowerCase();
  const reset = /^\/(подтвердить-сброс|отменить-сброс)(?:\s+(\S+))?$/u.exec(clean);
  if (reset)
    return /^[a-f0-9]{16}$/u.test(reset[2] ?? '')
      ? { kind: reset[1] === 'подтвердить-сброс' ? 'confirm' : 'cancel', code: reset[2]! }
      : { kind: 'invalid' };
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

function parseButton(message: VkIncoming): Command | undefined {
  if (!message.payload) return undefined;
  let payload;
  try {
    payload = vkRecord(JSON.parse(message.payload));
  } catch {
    return undefined;
  }
  if (!payload || !Object.hasOwn(payload, 'pausedChat')) return undefined;
  const command =
    typeof payload.pausedChat === 'string' ? parseCommand(payload.pausedChat) : undefined;
  return command &&
    (command.kind === 'continue' || command.kind === 'new') &&
    message.text === buttonLabels[command.kind]
    ? command
    : { kind: 'invalid' };
}

function displayTitle(title: string | null) {
  return Array.from((title ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').trim())
    .slice(0, 120)
    .join('');
}

function chatLabel(chatId: string, title: string | null) {
  const name = displayTitle(title);
  return name ? `Беседа ${chatId} «${name}»` : `Беседа ${chatId}`;
}

function pauseReason(row: PausedConnection) {
  return row.reason ? reasonText[row.reason] : 'Причина прежней паузы не сохранена.';
}

function buttonCommand(row: PausedConnection, kind: keyof typeof buttonLabels) {
  return `${buttonLabels[kind]} ${row.chatId} ${row.generation}/${row.revision}`;
}

function textRow(row: PausedConnection) {
  return [
    `${chatLabel(row.chatId, row.title)}. ${pauseReason(row)}`,
    buttonCommand(row, 'continue'),
    'Сохраняет текущую историю и настройки. Сообщения за время паузы могут отсутствовать.',
    buttonCommand(row, 'new'),
    'Удаляет данные прежнего подключения после отдельного подтверждения.',
  ].join('\n');
}

function formatOverview(overview: readonly PausedConnection[]): readonly string[] {
  if (overview.length === 0) return ['Приостановленных бесед нет.'];
  const parts: string[] = [];
  let part = overviewTitle;
  for (const row of overview) {
    const next = `\n\n${textRow(row)}`;
    if (Buffer.byteLength(part + next) > vkMessageLength.value) {
      parts.push(part);
      part = overviewTitle;
    }
    part += next;
  }
  parts.push(part);
  return parts;
}

export function createPausedChatCommands(options: {
  readonly channel: Pick<
    ReturnType<typeof createVkChannel>,
    'replyPrivateControl' | 'reminderDelivery' | 'groupTitle'
  >;
  readonly lifecycle: Pick<
    ReturnType<typeof createLifecycleService>,
    | 'pausedConnections'
    | 'decidePaused'
    | 'requestPausedReset'
    | 'resetWarningDelivered'
    | 'answerPausedReset'
  >;
  readonly ownerId: UserId;
  readonly signal: AbortSignal;
}) {
  const { channel, lifecycle, ownerId, signal } = options;

  async function titleFor(
    row: Pick<PausedConnection, 'chatId' | 'title'>,
    guard: PublicationGuard,
  ) {
    return displayTitle(row.title) || displayTitle(await channel.groupTitle(row.chatId, guard));
  }

  async function showOverview(sender: UserId, inline: boolean, guard: PublicationGuard) {
    if (!guard.isCurrent()) return;
    const overview = lifecycle.pausedConnections('vk', sender);
    if (!overview.length || !inline) {
      for (const part of formatOverview(overview)) {
        if (!guard.isCurrent()) return;
        await channel.replyPrivateControl(sender, part, guard);
      }
      return;
    }
    for (const [index, row] of overview.entries()) {
      if (!guard.isCurrent()) return;
      const title = await titleFor(row, guard);
      if (!guard.isCurrent()) return;
      const heading = title ? `«${title}» · ${row.chatId}` : `Беседа ${row.chatId}`;
      const header = index === 0 ? `${overviewTitle} · ${overview.length}\n\n` : '';
      const keyboard = Keyboard.builder()
        .textButton({
          label: buttonLabels.continue,
          payload: { pausedChat: buttonCommand(row, 'continue') },
          color: Keyboard.POSITIVE_COLOR,
        })
        .textButton({
          label: buttonLabels.new,
          payload: { pausedChat: buttonCommand(row, 'new') },
          color: Keyboard.SECONDARY_COLOR,
        })
        .inline();
      const text = [
        header + heading,
        pauseReason(row),
        'При продолжении история сохранится. Сброс удалит прежние данные после подтверждения.',
      ].join('\n');
      await channel.replyPrivateControl(sender, text, guard, {
        json: keyboard.toString(),
        fallbackText: header + textRow({ ...row, title }),
      });
    }
  }

  async function handle(
    command: Command,
    sender: UserId,
    message: VkIncoming,
    current: () => boolean,
    fromButton: boolean,
  ) {
    const event = message.cmid;
    const isCurrent = () => !signal.aborted && current();
    if (!isCurrent()) return;
    const guard = { signal, isCurrent, allow: async () => isCurrent() };
    const inline = message.inlineKeyboard !== false;
    if (command.kind === 'list') return showOverview(sender, inline, guard);
    if (command.kind === 'invalid') {
      await channel.replyPrivateControl(
        sender,
        inline
          ? 'Отправьте «Приостановленные беседы» и выберите действие под нужной беседой.'
          : 'Скопируйте целую команду из списка «Приостановленные беседы».',
        guard,
      );
      return;
    }
    let outcome: string;
    try {
      if ('code' in command) {
        const result = lifecycle.answerPausedReset(
          sender,
          command.code,
          event,
          command.kind === 'confirm',
        );
        outcome =
          result.state === 'confirmed'
            ? `Для беседы ${result.chatId} начато новое подключение. Данные прежнего подключения удалены.`
            : `Сброс беседы ${result.chatId} отменён.`;
      } else if (command.kind === 'new') {
        const request = lifecycle.requestPausedReset(command.selected, sender, event);
        if (request.state !== 'pending') return;
        const title = fromButton ? await titleFor(request, guard) : request.title;
        const text = [
          `${chatLabel(request.chatId, title)}. Сброс удалит историю, профили и настройки прежнего подключения.`,
          'Чтобы начать заново, подтвердите в течение 15 минут. При отмене беседа останется на паузе.',
          `/подтвердить-сброс ${request.code}`,
          `/отменить-сброс ${request.code}`,
        ].join('\n');
        let receipt: number | undefined;
        const sent = await channel.reminderDelivery(sender).publish(
          text,
          request.sendId,
          (id) => {
            receipt = Number(id);
          },
          guard,
        );
        if (sent === 'delivered' && receipt !== undefined && isCurrent())
          lifecycle.resetWarningDelivered(sender, request.code, receipt);
        return;
      } else {
        const listed = fromButton
          ? lifecycle
              .pausedConnections('vk', sender)
              .find((row) => row.chatId === command.selected.chatId)
          : undefined;
        lifecycle.decidePaused(command.selected, sender, 'continue');
        const title = listed && (await titleFor(listed, guard));
        outcome = title
          ? `Беседа «${title}» возобновлена.`
          : `Беседа ${command.selected.chatId} продолжена. История и настройки сохранены.`;
      }
    } catch (error) {
      if (!(error instanceof StorageError && error.code === 'stale_scope')) throw error;
      if (fromButton && 'selected' in command) {
        await channel.replyPrivateControl(
          sender,
          `Состояние беседы ${command.selected.chatId} изменилось.`,
          guard,
        );
        return showOverview(sender, inline, guard);
      }
      outcome =
        'selected' in command
          ? `Состояние беседы ${command.selected.chatId} изменилось. Обновите список командой «Приостановленные беседы».`
          : 'Код недействителен или срок подтверждения истёк. Обновите список командой «Приостановленные беседы».';
    }
    await channel.replyPrivateControl(sender, outcome, guard);
  }

  return (message: VkIncoming, isCurrent: () => boolean): Promise<void> | undefined => {
    const button = parseButton(message);
    const command = button ?? parseCommand(message.text);
    if (!command) return undefined;
    const sender = vkChatId(message.authorId);
    if (
      sender !== ownerId ||
      message.peerId !== message.authorId ||
      message.authorId <= 0 ||
      isVkGroupChat(message.peerId) ||
      message.attachments.length ||
      message.isMentioned ||
      message.hasReply ||
      message.reply ||
      message.hasForwarded
    )
      return Promise.resolve();
    return handle(command, sender, message, isCurrent, button !== undefined);
  };
}
