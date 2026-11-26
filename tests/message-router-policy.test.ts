import { expect, test } from 'vitest';
import { routeMessage } from '../src/core/message-router/routing';
import { directlyAddressesName } from '../src/core/message-router/name-address';
import { publicationDecision } from '../src/core/message-router/publication';
import type { IncomingMessage } from '../src/contracts/index';
export const incoming: IncomingMessage = {
  kind: 'message',
  chatId: 'vk:a',
  userId: 'vk:u',
  authorName: '',
  isGroupChat: true,
  isAdmin: false,
  isBot: false,
  text: 'Пенек помоги с задачей',
  messageId: '1',
  isMentioned: false,
  isReplyToBot: false,
  timestamp: 0,
  attachments: [],
};

test.each(['пенек', 'пенёк', 'пнечек', 'пенёчек', 'пеньчик', 'пеньку', 'пнечке'])(
  'отбор для Haiku узнаёт форму «%s» внутри целого слова',
  (name) => {
    for (const text of [
      name + ' сделай мне тест на язык любви',
      'Как ты ' + name.toUpperCase() + ' решишь эту задачу?',
      'Сколько будет дважды два ' + name[0]!.toUpperCase() + name.slice(1),
    ])
      expect(
        routeMessage({
          message: { ...incoming, text },
          settings: { enabled: true, responseMode: 'normal' },
          replyGate: { allowInitiative: false },
        }),
      ).toEqual({ kind: 'assessment', reason: 'assessment', assessment: { kind: 'name' } });
  },
);

test('отбор для Haiku различает явную адресацию, оценку имени, инициативу и журнал', () => {
  function select(
    text: string,
    responseMode: 'normal' | 'active' | 'silent' = 'normal',
    flags: Partial<IncomingMessage> = {},
    allowInitiative = true,
  ) {
    return routeMessage({
      message: { ...incoming, ...flags, text },
      settings: { enabled: true, responseMode },
      replyGate: { allowInitiative },
    });
  }
  const name = 'Маша, там написано «ПнЕчЕк сделай мне тест»';
  expect(select(name)).toMatchObject({ assessment: { kind: 'name' } });
  expect(select('Обсуждали, как работает Пнечек')).toMatchObject({ assessment: { kind: 'name' } });
  expect(select('В лесу у тропинки стоит пенёк')).toMatchObject({ assessment: { kind: 'name' } });
  for (const text of [
    'Маша, сколько будет дважды два?',
    'Пенал у Маши',
    'суперпеньчик',
    'Дядя Пень, ответь',
  ])
    expect(select(text)).toEqual({ kind: 'silence', reason: 'not_addressed' });
  expect(select('На столе три настолки', 'active')).toMatchObject({
    assessment: { kind: 'initiative' },
  });
  const attachments = [{ kind: 'photo' }];
  expect(select('На столе три настолки', 'active', { attachments })).toMatchObject({
    reason: 'not_addressed',
  });
  expect(select('Пенёк, взгляни на снимок', 'active', { attachments })).toMatchObject({
    assessment: { kind: 'name' },
  });
  expect(select(name, 'active', {}, false)).toMatchObject({ assessment: { kind: 'name' } });
  expect(select('На столе три настолки', 'active', {}, false)).toMatchObject({ kind: 'silence' });
  expect(select(name, 'silent')).toMatchObject({ reason: 'silent' });
  expect(select(name, 'active', { replyAddress: 'unknown' })).toMatchObject({
    reason: 'reply_unknown',
  });
  expect(select(name, 'active', { replyAddress: 'other' })).toMatchObject({
    reason: 'reply_other',
  });
  expect(
    select(name, 'active', { replyAddress: 'other', isMentioned: true, soleBotMention: true }),
  ).toMatchObject({ kind: 'ordinary', reason: 'mention' });
  expect(select(name, 'normal', { isMentioned: true })).toMatchObject({ reason: 'mention' });
  expect(select(name, 'normal', { isReplyToBot: true, replyAddress: 'bot' })).toMatchObject({
    reason: 'reply',
  });
  expect(select(name, 'active', { isGroupChat: false })).toMatchObject({
    reason: 'direct_message',
  });
});

test('служебный ответ и ввод открытой анкеты предшествуют оценке Haiku', () => {
  const message = { ...incoming, text: 'Пенёк, вот мой ответ' };
  const flags = {
    message,
    settings: { enabled: true, responseMode: 'active' },
    replyGate: { allowInitiative: true },
  } as const;
  expect(
    routeMessage({
      ...flags,
      service: {
        allowed: true,
        role: 'member',
        command: { action: 'commands.read', minimumRole: 'member' },
      },
    }),
  ).toEqual({ kind: 'service', reason: 'service' });
  expect(routeMessage({ ...flags, questionnaireName: true })).toMatchObject({
    kind: 'ordinary',
    reason: 'name',
  });
});
test('прямой вход предшествует трём закрытым поводам; неоднозначные реплики молчат', () => {
  const detect = (
    text: string,
    extra: Partial<IncomingMessage> = {},
    responseMode: 'active' | 'normal' | 'silent' = 'active',
  ) =>
    routeMessage({
      message: { ...incoming, text, ...extra },
      settings: { enabled: true, responseMode },
      considerInitiative: true,
    });
  expect(detect('Пенёк, подскажи')).toMatchObject({ kind: 'ordinary', reason: 'name' });
  expect(detect('Обсуждали, как работает Пенёк')).toMatchObject({ initiative: 'free_mention' });
  expect(detect('Кто-нибудь, помогите разобраться с расписанием')).toMatchObject({
    initiative: 'help',
  });
  expect(detect('Во сколько встречаемся у фонтана?')).toMatchObject({ initiative: 'unanswered' });
  for (const text of [
    'Маша, помоги с расписанием',
    'Он сказал «Обсуждали, как работает Пенёк»',
    'Почему Пенёк молчит?',
    'Кто-нибудь, помогите разобраться с угрозой',
    'Где встречаемся?',
  ])
    expect(detect(text)).not.toHaveProperty('initiative');
  for (const extra of [
    { hasOtherAddress: true },
    { replyAddress: 'other' },
    { replyAddress: 'unknown' },
    { isBot: true },
    { isBot: 'unknown' },
    { isGroupChat: false },
  ] as const)
    expect(detect('Кто-нибудь, помогите с расписанием', extra)).not.toHaveProperty('initiative');
  for (const mode of ['normal', 'silent'] as const)
    expect(detect('Кто-нибудь, помогите с расписанием', {}, mode)).not.toHaveProperty('initiative');
});
for (const mode of ['silent', 'normal', 'active'] as const)
  for (const isBot of [false, true, 'unknown'] as const)
    test(`${mode} ${isBot}`, () => {
      const result = routeMessage({
        message: { ...incoming, isBot },
        settings: { enabled: true, responseMode: mode },
      });
      expect(result.kind).toBe(mode !== 'silent' && isBot === false ? 'ordinary' : 'silence');
      if (isBot === 'unknown') expect(result.reason).toBe('sender_unknown');
    });
test('личка active→normal; выключенный обычный путь молчит', () => {
  expect(
    routeMessage({
      message: { ...incoming, isGroupChat: false, text: 'любой текст' },
      settings: { enabled: true, responseMode: 'active' },
    }),
  ).toMatchObject({ route: { mode: 'normal', kind: 'direct_message' } });
  expect(
    routeMessage({ message: incoming, settings: { enabled: false, responseMode: 'normal' } }),
  ).toMatchObject({ reason: 'disabled' });
  expect(
    routeMessage({
      message: { ...incoming, isBot: undefined } as unknown as IncomingMessage,
      settings: { enabled: true, responseMode: 'normal' },
    }),
  ).toMatchObject({ reason: 'invalid_input' });
});
for (const text of [
  'Пенек помоги с задачей',
  'Помоги с задачей Пенёк',
  'Подскажи пожалуйста Пенёк как это сделать',
  'Как ты думаешь Пенек',
  'Как дела Пенёк',
  'ПЕНЁК!',
  'Пенек, помоги!',
  'Помоги! Пенек?',
  'Пенёк, где встречаемся завтра?',
  'Где встречаемся завтра, Пенек?',
  'Где, Пенёк, встречаемся завтра?',
  'Где встречаемся, ПЕНЁК, завтра?',
  'пенек где встречаемся завтра',
  'Пенёк, во сколько выходим?',
  'Куда мы сегодня идём, Пенёк?',
  'Пенёк! Где встречаемся завтра?',
  'Где встречаемся завтра? Пенёк!',
  'Когда освободишься, Пенёк?',
])
  test(text, () => expect(directlyAddressesName(text)).toBe(true));
for (const text of [
  'Пенёк сегодня молчит',
  'Мы обсуждали бота Пенек',
  'Он сказал: “Пенёк помоги”',
  'Иван помоги настроить Пенек',
  'Пенёчек',
  'суперпенек',
  'Почему Пенёк молчит',
  'Как ты думаешь почему Пенёк молчит',
  'Где Пенёк?',
  'Куда ушёл Пенёк?',
  'Где сегодня Пенёк встречал гостей?',
  'Где встречаемся, если Пенёк опаздывает?',
  'Где встречаемся? Пенёк приедет вечером.',
  'Где встречаемся, Пенёк туда придёт?',
  'Где будем искать пенёк?',
  'Где встречаемся завтра?',
  'Где встречаемся завтра, суперпенек?',
  'Где встречаемся завтра, «Пенёк»?',
  '«Пенёк, где встречаемся завтра?»',
  'Пенёк сегодня стоит. «Где встречаемся завтра?»',
])
  test(text, () => expect(directlyAddressesName(text)).toBe(false));

test.each([
  ['normal', {}, 'ordinary', 'name'],
  ['active', {}, 'ordinary', 'name'],
  ['silent', {}, 'silence', 'silent'],
  ['normal', { isBot: 'unknown' }, 'silence', 'sender_unknown'],
  ['normal', { replyAddress: 'other' }, 'silence', 'reply_other'],
  ['normal', { replyAddress: 'unknown' }, 'silence', 'reply_unknown'],
  ['normal', { isMentioned: true }, 'ordinary', 'mention'],
  ['normal', { replyAddress: 'bot', isReplyToBot: true }, 'ordinary', 'reply'],
] as const)(
  'явный вопрос по имени в режиме %s с признаками %j',
  (responseMode, flags, kind, reason) => {
    expect(
      routeMessage({
        message: { ...incoming, text: 'Пенёк, где встречаемся завтра?', ...flags },
        settings: { enabled: true, responseMode },
        considerInitiative: true,
      }),
    ).toMatchObject({ kind, reason });
  },
);

test.each([
  'Пенёк, объясни фразу «что было вчера?»',
  'Пенёк, что было вчера?',
  'Пенёк, дай сводку за вчера. В чате это назвали «репетицией».',
])('адресованный запрос «%s» проходит по имени', (text) => {
  expect(
    routeMessage({
      message: { ...incoming, text },
      settings: { enabled: true, responseMode: 'normal' },
    }),
  ).toMatchObject({ kind: 'ordinary', reason: 'name' });
});

test('части вопроса по обе стороны цитаты не образуют адресованный пересказ', () => {
  expect(
    routeMessage({
      message: { ...incoming, text: 'Пенёк, что«цитата»было вчера?' },
      settings: { enabled: true, responseMode: 'normal' },
    }),
  ).toEqual({ kind: 'silence', reason: 'not_addressed' });
});

for (const kind of [
  'incomplete',
  'refused',
  'empty',
  'tools_not_supported',
  'deadline_exceeded',
  'attempt_limit',
  'error',
  'failed',
  'queue_full',
])
  test('публикация ' + kind, () => {
    const route = { kind: 'name', mode: 'normal', isGroupChat: true } as const;
    expect(
      publicationDecision(
        route,
        { enabled: true, responseMode: 'normal' },
        { kind, partialText: 'SECRET', message: 'SECRET' },
      ),
    ).toEqual({ kind: 'notice' });
    expect(
      publicationDecision(
        { ...route, mode: 'active' },
        { enabled: true, responseMode: 'active' },
        { kind },
      ),
    ).toEqual({ kind: 'silence' });
  });
test.each(['rate_limit', 'llm_wait_timeout', 'llm_provider_paused'] as const)(
  'публикация результата доступности модели %s',
  (kind) => {
    const route = { kind: 'name', mode: 'normal', isGroupChat: true } as const;
    expect(publicationDecision(route, { enabled: true, responseMode: 'normal' }, { kind })).toEqual(
      {
        kind: 'notice',
        template: kind,
      },
    );
    expect(
      publicationDecision(
        { ...route, mode: 'active' },
        { enabled: true, responseMode: 'active' },
        { kind },
      ),
    ).toEqual({ kind: 'silence' });
  },
);
for (const kind of ['cancelled', 'expired', 'interrupted', 'message_missing', 'UNKNOWN'])
  test('молчание ' + kind, () =>
    expect(
      publicationDecision(
        { kind: 'name', mode: 'normal', isGroupChat: true },
        { enabled: true, responseMode: 'normal' },
        { kind },
      ),
    ).toEqual({ kind: 'silence' }),
  );

test.each([
  ['other', false, false, 'reply_other'],
  ['other', true, false, 'reply_other'],
  ['other', true, true, 'mention'],
  ['unknown', true, true, 'reply_unknown'],
  ['bot', false, false, 'reply'],
] as const)(
  'адресация reply %s с упоминанием %s и единственностью %s',
  (replyAddress, isMentioned, soleBotMention, reason) => {
    const message = {
      ...incoming,
      replyAddress,
      isMentioned,
      soleBotMention,
      isReplyToBot: replyAddress === 'bot',
    };
    expect(
      routeMessage({ message, settings: { enabled: true, responseMode: 'normal' } }).reason,
    ).toBe(reason);
  },
);
