import type { IncomingMessage } from '../contracts/index';

export const helpAction = {
  action: 'commands.read',
  minimumRole: 'member',
  journalLabel: 'Подсказка по командам',
} as const;

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
    !message.isGroupChat ||
    message.isMentioned ||
    message.isReplyToBot ||
    /^\/анкета(?:\s|$)/iu.test(text)
  );
}

export function unknownHint(text: string) {
  return /^\/анкета(?:\s|$)/iu.test(text.trim())
    ? 'Неизвестная команда анкеты. Для паузы отправьте /анкета пауза, для отмены — /анкета отмена.'
    : 'Неизвестная команда. Проверьте написание команды.';
}
