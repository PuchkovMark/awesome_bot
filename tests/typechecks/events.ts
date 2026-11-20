import type { ChatId, IncomingEvent, IncomingMessage, MembershipEvent, OutgoingMessage } from '../../src/contracts/index.js';

export const message: IncomingMessage = {
  kind: 'message', chatId: 'test-a:chat', userId: 'test-a:user', authorName: 'Имя',
  isGroupChat: true, isAdmin: 'unknown', isBot: false, text: 'Текст', messageId: '1',
  isReplyToBot: false, isMentioned: true, timestamp: 0, attachments: [],
};
export const membership: MembershipEvent = {
  kind: 'membership', chatId: 'test-a:chat', timestamp: 0,
  subjectId: null, actorId: null, change: 'unknown',
};
export const outgoing: OutgoingMessage = { chatId: 'test-a:chat', text: 'Ответ', replyToMessageId: '1' };

// @ts-expect-error — составной идентификатор требует префикса с двоеточием.
export const missingPrefix: ChatId = 'chat';
const { attachments, ...withoutAttachments } = message;
export const attachmentsExample = attachments;
// @ts-expect-error — обязательный список вложений нельзя пропустить.
export const missingAttachments: IncomingMessage = withoutAttachments;
// @ts-expect-error — неизвестное знание обозначается unknown, а не произвольной строкой.
export const invalidAdmin: IncomingMessage = { ...message, isAdmin: 'maybe' };
// @ts-expect-error — числовой id не является строковым платформенным id.
export const invalidId: IncomingMessage = { ...message, messageId: 1 };
// @ts-expect-error — неизвестный вид события не входит в контракт.
export const invalidKind: IncomingEvent = { ...message, kind: 'other' };
// @ts-expect-error — поля сообщения не относятся к служебному варианту.
export const mixedEvent: MembershipEvent = { ...membership, text: 'Текст' };
// @ts-expect-error — null участник допустим, но отсутствие поля недопустимо.
export const missingSubject: MembershipEvent = { kind: 'membership', chatId: 'test-a:chat', timestamp: 0, actorId: null, change: 'left' };

export function requiresNarrowing(event: IncomingEvent): void {
  // @ts-expect-error — до сужения вида нельзя получить текст сообщения.
  void event.text;
  if (event.kind === 'message') {
    void event.text;
    // @ts-expect-error — у сообщения нет изменения участия.
    void event.change;
  }
}
