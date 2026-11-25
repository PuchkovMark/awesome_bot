import type { BotRole, IncomingMessage } from '../contracts/index';
import { vkMentionCommand } from '../channels/vk/normalize';

export const helpAction = {
  action: 'commands.read',
  minimumRole: 'member',
  journalLabel: 'Подсказка по командам',
} as const;

const helpRequest = /^\/(?:помощь|команды)(?:\s+([\s\S]+))?$/iu;

export function isCommandHelp(text: string) {
  return helpRequest.test(text.trim());
}

export function commandHelp(
  role: BotRole,
  group: boolean,
  enabled: boolean,
  mode: 'normal' | 'active' | 'silent',
  actor: string,
  request = '/помощь',
) {
  const ordinary = enabled && mode !== 'silent';
  const manage = enabled && group && role !== 'member';
  const topic = helpRequest.exec(request.trim())?.[1]?.toLowerCase();
  const topics: string[] = [];
  if (ordinary || manage) {
    const actions = [ordinary && 'заполнение и просмотр', manage && 'вопросы беседы'].filter(
      Boolean,
    );
    topics.push('/помощь анкета — ' + actions.join(', ') + '.');
  }
  if (ordinary)
    topics.push(
      '/помощь профиль — посмотреть и исправить свои факты.',
      '/помощь напоминания — создать, посмотреть или отменить.',
    );
  if (topic === 'анкета' && (ordinary || manage)) {
    const lines = ['Анкета'];
    if (ordinary) {
      lines.push(
        '/анкета — начать или продолжить заполнение.',
        '/анкета показать — посмотреть свою анкету.',
        '/анкета пауза · /анкета отмена — приостановить или отменить заполнение.',
      );
      if (group)
        lines.push(
          `/анкета показать @id${actor.slice(3)} — пример просмотра по упоминанию.`,
          '/анкета изменить — исправить свой ответ.',
          '/анкета удалить — удалить свою анкету с подтверждением.',
          '/анкета представить — разрешить представление в беседе.',
        );
    }
    if (manage)
      lines.push('/вопросы — посмотреть общие вопросы. /вопросы изменить — открыть редактор.');
    return lines.join('\n');
  }
  if (topic === 'профиль' && ordinary)
    return [
      'Профиль',
      group
        ? '/профиль — получить в личке список своих фактов из этой беседы.'
        : '/профиль — открыть профиль этого личного диалога. Для выбора беседы укажите её ID, например /профиль vk:2000000001.',
      'Чтобы исправить факт, ответьте на ту часть личного списка, где он указан. Подставьте номер факта и новое значение, например /исправить 2 Казань.',
    ].join('\n');
  if (topic === 'напоминания' && ordinary) {
    return [
      'Личные напоминания',
      (group ? 'Пенёк, напомни' : 'Напомни') +
        ' мне через 20 минут взять документы — создать напоминание. Оно придёт в личку.',
      'В личке: Мои напоминания — посмотреть список.',
      'В личке: Отмени напоминание — выбрать задание. Отмени напоминание 12 — пример отмены по номеру.',
      'В личке: /пояс-напоминаний Europe/Moscow — выбрать часовой пояс.',
    ].join('\n');
  }
  if (topic)
    return topics.length
      ? ['Доступные темы', ...topics].join('\n')
      : 'Открыть доступные команды — /помощь.';
  const lines = ['Доступные команды', ...topics];
  if (ordinary) {
    lines.push(
      '/профиль — свои факты. /мои-данные — выгрузка.',
      '/отключить-профиль · /удалить-мои-данные · /статус-удаления',
    );
    if (group) lines.push('Пенёк, что было вчера? — пересказать переписку.');
    if (group && mode === 'active')
      lines.push('Помолчи — поставить самостоятельные реплики на паузу.');
  }
  if (ordinary || manage) lines.push('/персонаж — текущий персонаж и доступные имена.');
  if (group && (ordinary || manage))
    lines.push('/паспорт — сведения о беседе. /правила — правила.');
  if (manage)
    lines.push(
      '/настройки · /режим · /тихие-часы · /часовой-пояс',
      '/приветствие · /приглашение — посмотреть состояние и варианты.',
    );
  if (!group && role === 'owner')
    lines.push(
      'Приостановленные беседы — управление подключениями.',
      '/беседы-без-админов — восстановление управления.',
      'Показать расход — расход по беседам.',
    );
  return lines.join('\n');
}

const namedSlash = /^\s*пен[её]к\s*,\s*(\/[\s\S]*)$/iu;

export function commandInput(message: IncomingMessage, groupId: number): IncomingMessage {
  if (
    !message.isGroupChat ||
    message.isBot !== false ||
    message.hasForwarded ||
    message.attachments.length ||
    message.replyAddress === 'other' ||
    message.replyAddress === 'unknown'
  )
    return message;
  const literal = message.literalText ?? message.text;
  const command =
    namedSlash.exec(literal)?.[1] ??
    (message.isMentioned
      ? (vkMentionCommand(literal, groupId) ?? namedSlash.exec(message.text)?.[1])
      : undefined);
  return command ? { ...message, text: command, literalText: literal } : message;
}

export function addressedSlash(message: IncomingMessage) {
  if (
    message.isBot !== false ||
    message.hasForwarded ||
    message.attachments.length ||
    message.replyAddress === 'other' ||
    message.replyAddress === 'unknown' ||
    message.hasOtherAddress
  )
    return false;
  const text = message.text.trim();
  if (!text.startsWith('/')) return false;
  return (
    namedSlash.test(message.literalText ?? '') ||
    isCommandHelp(text) ||
    !message.isGroupChat ||
    message.isMentioned ||
    message.isReplyToBot ||
    /^\/анкета(?:\s|$)/iu.test(text)
  );
}

export function unknownHint(text: string, activeForm = false) {
  const management = /^\/анкета\s+(изменить|удалить)$/iu.exec(text.trim());
  if (management)
    return `Отправьте /анкета ${management[1]!.toLowerCase()} в беседе, где вы заполнили анкету.`;
  return activeForm || /^\/анкета(?:\s|$)/iu.test(text.trim())
    ? 'Неизвестная команда анкеты. Для паузы отправьте /анкета пауза, для отмены — /анкета отмена.'
    : 'Неизвестная команда. Список доступных команд — /помощь.';
}
