import type { BotRole, IncomingMessage } from '../contracts/index';

export const helpAction = {
  action: 'commands.read',
  minimumRole: 'member',
  journalLabel: 'Подсказка по командам',
} as const;

export function isCommandHelp(text: string) {
  return /^\/(?:помощь|команды)$/iu.test(text.trim());
}

export function commandHelp(
  role: BotRole,
  group: boolean,
  enabled: boolean,
  mode: 'normal' | 'active' | 'silent',
  actor: string,
) {
  const lines = ['Доступные команды'];
  const manage = role !== 'member';
  if (enabled && mode !== 'silent') {
    lines.push(
      '/анкета — начать или продолжить заполнение, после заполнения — посмотреть свою анкету.',
      '/анкета пауза · /анкета отмена — приостановить или отменить заполнение.',
      '/анкета показать — посмотреть свою анкету.',
    );
    if (group)
      lines.push(
        `/анкета показать @id${actor.slice(3)} — пример просмотра по упоминанию участника.`,
        '/анкета изменить — исправить ответ или заполнить пропуск.',
        '/анкета удалить — удалить свою анкету с подтверждением в этой беседе.',
        '/анкета представить — разрешить представление в беседе.',
      );
    lines.push(
      '/профиль — получить свой список фактов в личке.',
      '/мои-данные — получить выгрузку. /статус-удаления — проверить удаление.',
      '/отключить-профиль — отключить профиль. /удалить-мои-данные — запросить удаление всех своих данных этого чата.',
      '/персонаж — посмотреть персонажей.',
    );
    if (group) {
      lines.push(
        'Пенёк, что было вчера? — пересказать обсуждение.',
        'Пенёк, напомни мне через 20 минут взять документы — создать личное напоминание.',
      );
      if (mode === 'active') lines.push('Помолчи — поставить самостоятельные реплики на паузу.');
    } else
      lines.push(
        'Мои напоминания — посмотреть свои задания.',
        '/пояс-напоминаний Europe/Moscow — выбрать пояс для напоминаний.',
      );
  }
  if (enabled && group && (mode !== 'silent' || manage)) {
    lines.push('/паспорт — посмотреть сведения о беседе. /правила — прочитать её правила.');
    if (manage)
      lines.push(
        '/настройки — посмотреть настройки беседы. /режим — выбрать режим.',
        '/тихие-часы 23:00–07:00 — задать интервал. /тихие-часы выкл — отключить его.',
        '/часовой-пояс Europe/Moscow — сменить пояс беседы.',
        '/вопросы — настроить вопросы анкеты.',
        '/приветствие вкл · /приглашение вкл — включить приветствие или приглашение к анкете. Для отключения укажите «выкл».',
      );
  }
  if (!group && role === 'owner')
    lines.push(
      'Приостановленные беседы — посмотреть список, продолжить беседу или запросить сброс.',
      '/беседы-без-админов — найти беседы для восстановления управления.',
      'Показать расход — посмотреть расход по беседам.',
    );
  return lines.join('\n');
}

export function slashText(message: IncomingMessage) {
  const own = message.text.trim();
  if (
    !message.isGroupChat ||
    message.hasForwarded ||
    message.hasOtherAddress ||
    message.replyAddress === 'other' ||
    message.replyAddress === 'unknown'
  )
    return own;
  return /^\s*пен[её]к\s*,\s*(\/[\s\S]*)$/iu.exec(own)?.[1] ?? own;
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
  const text = slashText(message);
  if (!text.startsWith('/')) return false;
  return (
    text !== message.text.trim() ||
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
