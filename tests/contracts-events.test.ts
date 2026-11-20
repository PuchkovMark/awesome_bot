import { expect, test } from 'vitest';
import type { IncomingEvent, IncomingMessage, MembershipChange } from '../src/contracts/index.js';

function describeEvent(event: IncomingEvent): string {
  switch (event.kind) {
    case 'message': return `message:${event.messageId}:${event.text}`;
    case 'membership': return `membership:${event.change}:${event.subjectId ?? 'unknown'}`;
    default: { const impossible: never = event; return impossible; }
  }
}

test('типизированный обработчик принимает сообщение с reply и вложением', () => {
  const message: IncomingMessage = {
    kind: 'message', chatId: 'test-a:chat', userId: 'test-a:user', authorName: 'Имя',
    isGroupChat: true, isAdmin: 'unknown', isBot: 'unknown', text: 'Абзац\nТекст',
    messageId: '1', replyToMessageId: '0', isReplyToBot: true, isMentioned: false,
    timestamp: 1_000, attachments: [{ kind: 'unknown', reference: 'opaque-attachment-id' }],
  };
  expect(describeEvent(message)).toBe('message:1:Абзац\nТекст');
  expect(describeEvent({ ...message, attachments: [] })).toBe('message:1:Абзац\nТекст');
});

test.each<MembershipChange>(['joined', 'invited', 'left', 'removed', 'unknown'])(
  'служебное изменение %s не требует текста или id события', (change) => {
    expect(describeEvent({ kind: 'membership', chatId: 'test-a:chat', timestamp: 1_000, subjectId: null, actorId: null, change }))
      .toBe(`membership:${change}:unknown`);
  },
);
