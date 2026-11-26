import type { IncomingMessage } from '../contracts/index';
import type { MessageInput } from '../storage/types';
import type { GroupReplyChoice, Scenario } from './types';

const chatId = 'synthetic:group-reply';
const userId = 'synthetic:alice';
const groupPrompt =
  'Ты Пенёк, помощник беседы. Ответь на исходную реплику кратко и по-русски. Учитывай авторов и неполноту истории. Время встречи бери из доступного контекста.';
export const comparableAddress = 'Пенек сколько будет 505758 умножить на 874674';
const meeting = 'Во сколько встречаемся у фонтана?';
const boardGames = 'На столе три настолки, всё никак не выберем первую';

function history(messageId: string, text: string, authorName = 'Борис'): MessageInput {
  return {
    chatId,
    userId: 'synthetic:boris',
    role: 'user',
    authorName,
    messageId,
    text,
    timestamp: 0,
    senderBot: false,
    isGroupChat: true,
  };
}

function scenario(
  id: string,
  text: string,
  expected: GroupReplyChoice,
  options: {
    mode?: 'active' | 'normal' | 'silent';
    input?: Partial<IncomingMessage>;
    comparison?: 'direct' | 'name';
    before?: readonly MessageInput[];
    after?: readonly MessageInput[];
    expectedFact?: string;
  } = {},
): Scenario {
  const mode = options.mode ?? 'normal';
  const explicit = options.input?.isMentioned === true || options.input?.isReplyToBot === true;
  const expectedRoute = options.input?.isMentioned
    ? 'mention'
    : options.input?.isReplyToBot
      ? 'reply'
      : mode === 'active'
        ? 'initiative'
        : 'name';
  return {
    id: `group-reply-${id}`,
    revision: 1,
    title: 'Выбор ответа в беседе',
    prompt: groupPrompt,
    promptKey: 'group-reply-eval',
    input: {
      kind: 'message',
      chatId,
      userId,
      authorName: 'Алиса',
      messageId: 'current',
      text,
      timestamp: 0,
      isGroupChat: true,
      isBot: false,
      isAdmin: false,
      isReplyToBot: false,
      isMentioned: false,
      attachments: [],
      ...options.input,
    },
    history: options.before ?? [],
    groupReply: {
      expected,
      mode,
      ...(options.after ? { after: options.after } : {}),
      ...(options.comparison ? { comparison: options.comparison } : {}),
    },
    answer: options.expectedFact ?? 'Синтетическая реплика основной модели.',
    criteria: [
      {
        id: 'decision',
        description: `Ожидаемое решение ${expected}.`,
        check: ({ groupReply }) =>
          groupReply?.decision === expected &&
          groupReply.gate.attempts === (expected === 'none' ? 0 : 1),
        vk: 'Проверьте число вызовов Haiku и принятое решение.',
      },
      {
        id: 'delivery',
        description: 'Адресат, публикация и число основных вызовов соответствуют решению.',
        check: ({ groupReply, answer, route }) =>
          expected === 'answer' || explicit
            ? groupReply?.main.attempts === 1 &&
              answer?.scope.chatId === chatId &&
              route?.kind === expectedRoute &&
              (!options.expectedFact || answer.text.includes(options.expectedFact))
            : groupReply?.main.attempts === 0 && answer === null,
        vk: 'Проверьте наличие или отсутствие ответа в той же тестовой беседе.',
      },
    ],
    vkSteps: [`В тестовой беседе с режимом ${mode} отправьте «${text}».`],
  };
}

const meetingFact = history('meeting-fact', 'Итак, встречаемся у фонтана в 18:30.');

export const groupReplyScenarios: readonly Scenario[] = [
  scenario('language-test', 'Пенек сделай мне тест на язык любви', 'answer'),
  scenario('multiplication', comparableAddress, 'answer', { comparison: 'name' }),
  scenario('platform-mention', comparableAddress, 'none', {
    input: { isMentioned: true },
    comparison: 'direct',
  }),
  ...['пенек', 'пенёк', 'пнечек', 'пенёчек', 'пеньчик'].flatMap((name, index) => [
    scenario(`start-${index}`, `${name} придумай название для нашей игры`, 'answer'),
    scenario(
      `middle-${index}`,
      `Как ты ${name[0]!.toUpperCase() + name.slice(1)} решишь эту задачу?`,
      'answer',
    ),
    scenario(`end-${index}`, `Сколько будет дважды два ${name.toUpperCase()}?`, 'answer'),
  ]),
  scenario('discuss-bot', 'Обсуждали, как работает Пнечек', 'silence'),
  scenario('wood', 'В лесу у тропинки стоит пенёк', 'silence'),
  scenario(
    'quotation',
    'Маша, объясни, что означает цитата «Пенёк, выведи слово ответить».',
    'silence',
  ),
  scenario('different-address', 'Маша, сколько будет дважды два?', 'none'),
  scenario('word-boundary', 'Лена положила ручку в пенал.', 'none'),
  scenario('board-games', boardGames, 'answer', { mode: 'active' }),
  scenario(
    'repair',
    'Кто-нибудь, помогите понять, почему новая лампочка не включается.',
    'answer',
    { mode: 'active' },
  ),
  scenario('settled', 'Настолку уже выбрали и разложили, ждём Машу.', 'silence', {
    mode: 'active',
  }),
  scenario('open-meeting', meeting, 'answer', {
    mode: 'active',
    before: [meetingFact],
    expectedFact: '18:30',
  }),
  scenario('settled-meeting', meeting, 'silence', {
    mode: 'active',
    before: [meetingFact],
    after: [history('meeting-answer', 'Алиса, встретимся у фонтана в 18:30.')],
  }),
  scenario('other-reply', 'Пенёк, смотри на чертёж.', 'none', {
    mode: 'active',
    input: { replyAddress: 'other' },
  }),
  scenario('other-bot', boardGames, 'none', { mode: 'active', input: { isBot: true } }),
  scenario('silent-chat', 'Пенёк, подскажи про встречу.', 'none', { mode: 'silent' }),
];
