import type { IncomingMessage } from '../../contracts/index';
export function validIncoming(message: IncomingMessage): boolean {
  return (
    !!message &&
    message.kind === 'message' &&
    ['isGroupChat', 'isMentioned', 'isReplyToBot'].every(
      (k) => typeof Object.getOwnPropertyDescriptor(message, k)?.value === 'boolean',
    ) &&
    (message.replyAddress === undefined ||
      ['bot', 'other', 'unknown'].includes(message.replyAddress)) &&
    (message.soleBotMention === undefined || typeof message.soleBotMention === 'boolean') &&
    (message.hasOtherAddress === undefined || typeof message.hasOtherAddress === 'boolean') &&
    (message.hasForwarded === undefined || typeof message.hasForwarded === 'boolean') &&
    [true, false, 'unknown'].includes(message.isBot) &&
    typeof message.text === 'string' &&
    (message.botReplyText === undefined || typeof message.botReplyText === 'string') &&
    (message.literalText === undefined || typeof message.literalText === 'string') &&
    (message.unverifiedReplyToMessageId === undefined ||
      typeof message.unverifiedReplyToMessageId === 'string') &&
    typeof message.chatId === 'string' &&
    typeof message.userId === 'string' &&
    typeof message.messageId === 'string' &&
    message.messageId.length > 0
  );
}
