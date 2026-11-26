import { expect, test } from 'vitest';
import type { IncomingMessage } from '../src/contracts/index';
import { incomingReminderCommand } from '../src/core/reminders/commands';

const reply: IncomingMessage = {
  kind: 'message',
  chatId: 'vk:2000000041',
  userId: 'vk:41',
  authorName: 'Ира',
  isGroupChat: true,
  isAdmin: false,
  isBot: false,
  text: 'напомни мне через 20 минут взять билет',
  messageId: '2',
  replyToMessageId: '1',
  replyAuthorId: 'vk:42',
  isReplyToBot: false,
  replyAddress: 'other',
  isMentioned: true,
  timestamp: 0,
  attachments: [],
};

test('подтверждённый ответ участнику с единственным упоминанием создаёт личное напоминание', () => {
  expect(incomingReminderCommand({ ...reply, soleBotMention: true })).toEqual({
    kind: 'create',
    input: 'через 20 минут взять билет',
  });
});

test.each([
  ['адресат ответа неизвестен', { replyAddress: 'unknown', soleBotMention: true }],
  ['имя набрано вручную', { text: 'Пенёк, ' + reply.text, isMentioned: false }],
  ['нет признака единственного упоминания', {}],
  ['единственное упоминание не подтверждено', { soleBotMention: false }],
  ['выбран ещё один адресат', { hasOtherAddress: true, soleBotMention: true }],
  ['запрошен список', { text: 'Мои напоминания', soleBotMention: true }],
  ['автор не подтверждён', { isBot: 'unknown', soleBotMention: true }],
  ['ответ пришёл из лички', { chatId: 'vk:41', isGroupChat: false, soleBotMention: true }],
] as const)('личное напоминание в ответе участнику недоступно, когда %s', (_reason, extra) => {
  expect(incomingReminderCommand({ ...reply, ...extra })).toBeUndefined();
});
