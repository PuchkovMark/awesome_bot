import type { IncomingMessage } from '../../contracts/index';

export type ReminderCommand =
  | { readonly kind: 'create'; readonly input: string }
  | { readonly kind: 'list' }
  | { readonly kind: 'cancel-options' }
  | { readonly kind: 'cancel'; readonly id: number }
  | { readonly kind: 'clarify'; readonly id?: number; readonly input: string }
  | { readonly kind: 'timezone'; readonly input: string };

const botName = /^пен[её]к(?![\p{L}\p{N}_])\s*[,!:.—-]?\s*/iu;
const directedToGroup = /^(?:и\s+|нам(?:\s|$)|всем(?:\s|$))/iu;
const timeFirst = /^(?:через|в|сегодня|завтра|послезавтра|вечером|утром|дн[её]м|ночью)(?:\s|$)/iu;

export function parseReminderCommand(text: string, group: boolean): ReminderCommand | undefined {
  const own = text.trim().replace(botName, '');
  if (/^мои напоминания[.!?]?$/iu.test(own)) return { kind: 'list' };
  const create = /^напомни(?:те)?\s+(?:(мне)\s+)?([\s\S]+)$/iu.exec(own);
  if (create) {
    const input = create[2]!.trim();
    if (!directedToGroup.test(input) && (create[1] || timeFirst.test(input))) {
      return { kind: 'create', input };
    }
  }
  if (group) return undefined;
  if (/^отмени(?:ть)? напоминание[.!]?$/iu.test(own)) return { kind: 'cancel-options' };
  const cancel = /^отмени(?:ть)? напоминание\s+#?(\d+)[.!]?$/iu.exec(own);
  if (cancel && Number.isSafeInteger(Number(cancel[1])))
    return { kind: 'cancel', id: Number(cancel[1]) };
  const clarify = /^уточни(?:ть)? напоминание(?:\s+#(\d+))?\s+([\s\S]+)$/iu.exec(own);
  if (clarify) {
    const input = clarify[2]!;
    const id = clarify[1] === undefined ? undefined : Number(clarify[1]);
    if (id === undefined || Number.isSafeInteger(id)) {
      return { kind: 'clarify', input, ...(id === undefined ? {} : { id }) };
    }
  }
  const zone = /^\/пояс-напоминаний(?:\s+(.+))?$/iu.exec(own);
  if (zone) return { kind: 'timezone', input: zone[1] ?? '' };
  return undefined;
}

export function incomingReminderCommand(message: IncomingMessage) {
  const replyToOther = message.replyAddress === 'other';
  if (
    message.isBot !== false ||
    message.hasOtherAddress ||
    message.replyAddress === 'unknown' ||
    (replyToOther &&
      (!message.isGroupChat || message.isMentioned !== true || message.soleBotMention !== true)) ||
    (!message.isGroupChat && message.chatId !== message.userId) ||
    (message.isGroupChat &&
      !message.isMentioned &&
      !message.isReplyToBot &&
      !botName.test(message.text.trim()))
  ) {
    return undefined;
  }
  const command = parseReminderCommand(message.text, message.isGroupChat);
  return replyToOther && command?.kind !== 'create' ? undefined : command;
}
