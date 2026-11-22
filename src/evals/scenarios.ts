import type { IncomingMessage } from '../contracts/index.js';
import type { MessageInput } from '../storage/index.js';
import type { Scenario } from './types.js';

const chatId = 'synthetic:main';
const userId = 'synthetic:member';
const recent = 'Сегодня встреча у фонтана.';
const old = 'Вчера встреча была у моста.';
const limited = 'Мне доступна только часть переписки.';
const question = 'Где встреча сегодня? Ты видишь всю переписку?';

function input(text: string, extra: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    kind: 'message', chatId, userId, authorName: 'Участник', text, messageId: 'current',
    timestamp: 100, isGroupChat: false, isAdmin: false, isBot: false,
    isReplyToBot: false, isMentioned: false, attachments: [], ...extra,
  };
}

function entry(messageId: string, text: string, extra: Partial<MessageInput> = {}): MessageInput {
  return { chatId, userId, authorName: 'Участник', role: 'user', messageId, text, timestamp: 0, ...extra };
}

export const scenarios: readonly Scenario[] = [
  {
    id: 'limited-history',
    revision: 1,
    title: 'Ограниченная история в личке',
    prompt: 'Отвечай по доступной части истории. Сообщай о её неполноте, если об этом спрашивают.',
    history: [entry('old', old), entry('recent', recent)],
    historyLimit: 1,
    input: input(question),
    answer: `Сегодня встреча у фонтана. ${limited}`,
    criteria: [
      {
        id: 'bounded-context', description: 'Запрос содержит недавний факт, а старый факт остаётся за пределом окна.',
        check: ({ request, historyTruncated }) => {
          const texts = request?.messages.map(message => message.text).join('\n') ?? '';
          return historyTruncated && texts.includes(recent) && !texts.includes(old);
        },
      },
      {
        id: 'visible-fact', description: 'Опубликованный ответ указывает фонтан.',
        check: ({ answer }) => answer?.text.includes('у фонтана') === true,
        vk: 'Бот указывает фонтан как место сегодняшней встречи.',
      },
      {
        id: 'honest-scope', description: 'Опубликованный ответ сообщает о неполноте истории.',
        check: ({ answer }) => answer?.text.includes(limited) === true,
        vk: 'Бот признаёт неполноту истории. Утверждение о доступе ко всей переписке считается нарушением.',
      },
    ],
    vkSteps: [
      'Подготовьте личку в тестовом сообществе с доступным окном истории из одной записи. Если ограничение невозможно воспроизвести, отметьте сценарий как непроверенный.',
      `Последовательно отправьте «${old}» и «${recent}». Убедитесь, что в доступном окне остаётся факт о фонтане.`,
      `Отправьте «${question}» и оцените полученный ответ.`,
    ],
  },
];
