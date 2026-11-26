import { expect, test } from 'vitest';
import type { IncomingMessage } from '../src/contracts/index';
import { incomingReminderCommand, parseReminderCommand } from '../src/core/reminders/commands';

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

test.each(['2', '#2'])('уточнение с номером %s выбирает своё напоминание', (number) => {
  const prefix = 'Уточни напоминание ' + number;
  expect(parseReminderCommand(prefix + ' завтра в 18:00', false)).toEqual({
    kind: 'clarify',
    id: 2,
    input: 'завтра в 18:00',
  });
  expect(parseReminderCommand(prefix, false)).toEqual({ kind: 'clarify', id: 2, input: '' });
});

test.each(['18:00', '27.11.2026 в 18:00', '27 ноября в 18:00', 'завтра в 18:00'])(
  'начало срока «%s» остаётся в уточнении без номера',
  (input) => {
    expect(parseReminderCommand('Уточни напоминание ' + input, false)).toEqual({
      kind: 'clarify',
      input,
    });
  },
);

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
