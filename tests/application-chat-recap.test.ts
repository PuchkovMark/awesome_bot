import { applicationSummaries } from '../src/app/chat-summaries';
import { tokenBudgetStore } from '../src/storage/token-budget-store';
import { expect, test, vi } from 'vitest';
import type { LlmClient } from '../src/llm/types';
import { fixture, until, chat, peer, answer } from './helpers/application-response-fixture';
const question = '[club314|Пенёк] Что было вчера?';
const recapAt = Date.UTC(2026, 10, 25, 12);
const yesterdayFrom = Date.UTC(2026, 10, 23, 21);
const yesterdayTo = Date.UTC(2026, 10, 24, 21);

async function seedYesterday(f: Awaited<ReturnType<typeof fixture>>) {
  await f.storage.chats.update(f.scope, { timezone: 'Europe/Moscow' });
  for (const [messageId, timestamp] of [
    ['before-yesterday', yesterdayFrom - 1],
    ['yesterday-first', yesterdayFrom],
    ['yesterday-last', yesterdayTo - 1],
    ['after-yesterday', yesterdayTo],
  ] as const)
    await f.storage.messages.append(f.scope, {
      chatId: chat,
      messageId,
      userId: 'vk:42',
      role: 'user',
      authorName: 'Ира',
      text: `Запись ${messageId}.`,
      timestamp,
    });
}

test('сначала служебный reply, затем сводка Haiku; повторный вопрос использует готовый день', async () => {
  const f = await fixture({ startAt: recapAt, summaryIntervalMs: 999999999 });
  try {
    await seedYesterday(f);
    f.complete.mockImplementation(async () => {
      expect(f.sends.some((row) => row.text === 'собираю, минутку')).toBe(true);
      return { ...answer, text: 'Встречаемся у дуба.' };
    });
    for (const text of ['«Пенёк, что было вчера?»', 'Он спросил: Пенёк, что было вчера?'])
      await f.journaled(f.submit(text));
    await f.journaled(f.submit('Пенёк, что было вчера?', 41, undefined, undefined, true));
    expect(f.sends.filter((row) => row.text === 'собираю, минутку')).toEqual([]);
    const first = f.submit('Пенёк, что было вчера?');
    await until(() =>
      expect(
        f.sends.some(
          (row) =>
            row.text === 'Встречаемся у дуба.' &&
            row.reply_message?.conversation_message_id === first,
        ),
      ).toBe(true),
    );
    const count = f.complete.mock.calls.length;
    expect(count).toBe(2);
    expect(
      f.db.prepare("SELECT purpose FROM messages WHERE text='собираю, минутку'").pluck().get(),
    ).toBe('service_notice');
    for (const text of [question, 'Пенёк, дай сводку за вчера. В чате это назвали «репетицией».']) {
      const next = f.submit(text);
      await until(() =>
        expect(
          f.sends.some(
            (row) =>
              row.text === 'Встречаемся у дуба.' &&
              row.reply_message?.conversation_message_id === next,
          ),
        ).toBe(true),
      );
    }
    expect(f.complete.mock.calls).toHaveLength(count);
    expect(f.sends.filter((row) => row.text === 'собираю, минутку')).toHaveLength(1);
    expect(
      f.db
        .prepare(
          `SELECT m.platform_message_id FROM chat_summaries s
        JOIN chat_summary_sources cs ON cs.summary_id=s.id JOIN messages m ON m.id=cs.message_id
        WHERE s.chat_id=? AND s.level='day' AND s.starts_at=? AND s.ends_at=? ORDER BY m.id`,
        )
        .pluck()
        .all(chat, yesterdayFrom, yesterdayTo),
    ).toEqual(['yesterday-first', 'yesterday-last']);
  } finally {
    await f.close();
  }
});

test.each([
  ['name', false],
  ['name', true],
  ['mention', false],
  ['mention', true],
  ['reply', true],
] as const)('объяснение цитаты проходит через %s при готовой сводке %s', async (route, ready) => {
  const ordinaryReply = 'Так спрашивают о событиях прошлого дня.';
  const recapReply = 'Вчера обсуждали встречу.';
  const main = vi.fn<LlmClient['complete']>(async () => ({ ...answer, text: ordinaryReply }));
  const auxiliary = vi.fn<LlmClient['complete']>(async () => ({ ...answer, text: recapReply }));
  const f = await fixture({
    startAt: recapAt,
    summaryIntervalMs: 999999999,
    auxiliaryModel: 'synthetic-recap',
    modelClients: { client: { complete: main }, auxiliaryClient: { complete: auxiliary } },
  });
  try {
    await seedYesterday(f);
    let summaryReply: (typeof f.sends)[number] | undefined;
    if (ready) {
      const id = f.submit('Пенёк, что было вчера?');
      await f.trace(id);
      summaryReply = f.sends.find(
        (row) => row.text === recapReply && row.reply_message?.conversation_message_id === id,
      );
      expect(summaryReply).toBeDefined();
      expect(auxiliary).toHaveBeenCalled();
    }
    expect(main).not.toHaveBeenCalled();
    const summaries = () =>
      f.db.prepare('SELECT * FROM chat_summaries WHERE chat_id=? ORDER BY id').all(chat);
    const summaryRows = summaries();
    if (ready) expect(summaryRows).toContainEqual(expect.objectContaining({ level: 'day' }));
    else expect(summaryRows).toEqual([]);
    const auxiliaryCalls = auxiliary.mock.calls.length;
    const sentBefore = f.sends.length;
    const prefixes = { name: 'Пенёк, ', mention: '[club314|Пенёк] ', reply: '' };
    const explanation = 'объясни фразу «что было вчера?»';
    const text = route === 'name' ? prefixes.name + explanation : explanation;
    const id = f.submit(
      prefixes[route] + explanation,
      41,
      route === 'reply' ? summaryReply : undefined,
    );
    const trace = await f.trace(id);
    expect(trace.payload).toMatchObject({
      route: { kind: route },
      publication: { status: 'delivered' },
    });
    expect(f.sends.slice(sentBefore)).toEqual([
      expect.objectContaining({
        peer_id: peer,
        text: ordinaryReply,
        reply_message: expect.objectContaining({ peer_id: peer, conversation_message_id: id }),
      }),
    ]);
    expect(
      (await f.storage.messages.list(f.scope, { limit: 30 })).find(
        (row) => row.messageId === String(id),
      ),
    ).toMatchObject({ role: 'user', text });
    expect(main).toHaveBeenCalledOnce();
    const request = main.mock.calls[0]![0];
    expect(JSON.parse(request.messages.at(-1)!.text!).current.text).toBe(text);
    expect(auxiliary).toHaveBeenCalledTimes(auxiliaryCalls);
    expect(summaries()).toEqual(summaryRows);
  } finally {
    await f.close();
  }
});

async function appendSource(f: Awaited<ReturnType<typeof fixture>>, name: string, minutes: number) {
  return f.storage.messages.append(f.scope, {
    chatId: chat,
    messageId: name,
    userId: 'vk:41',
    role: 'user',
    authorName: 'Ира',
    text: name,
    timestamp: f.start - 86400000 + minutes * 60000,
  });
}

async function seedClockHistory(f: Awaited<ReturnType<typeof fixture>>) {
  await f.storage.chats.update(f.scope, { timezone: 'Europe/Moscow' });
  const history = [
    ['Накануне', Date.UTC(2026, 10, 23, 20, 59)],
    ['Утреннее решение', Date.UTC(2026, 10, 24, 6)],
    ['Ровно в шесть', Date.UTC(2026, 10, 24, 15)],
    ['Перед восьмью', Date.UTC(2026, 10, 24, 16, 59)],
    ['Вечернее решение', Date.UTC(2026, 10, 24, 17)],
    ['Следующий день', Date.UTC(2026, 10, 24, 21)],
  ] as const;
  for (const [label, timestamp] of history)
    await f.storage.messages.append(f.scope, {
      chatId: chat,
      userId: 'vk:42',
      role: 'user',
      authorName: 'Ира',
      messageId: label,
      text: label,
      timestamp,
    });
  f.complete.mockImplementation(async (request) => ({
    ...answer,
    text:
      history
        .filter(([label]) => request.messages[0]?.text?.includes(label))
        .map(([label]) => label)
        .join(', ') || answer.text,
  }));
  return (id: number, expected: string) =>
    until(() =>
      expect(
        f.sends.find(
          (row) => row.reply_message?.conversation_message_id === id && row.text === expected,
        ),
      ).toBeDefined(),
    );
}

test.each([false, true])(
  'пересказ за часть вчерашнего дня учитывает обе границы, готовая дневная сводка %s',
  async (ready) => {
    const f = await fixture({
      startAt: Date.UTC(2026, 10, 25, 20, 59, 59),
      limit: 40,
      summaryIntervalMs: 999999999,
    });
    try {
      const result = await seedClockHistory(f);
      if (ready)
        await result(
          f.submit(question),
          'Утреннее решение, Ровно в шесть, Перед восьмью, Вечернее решение',
        );
      for (const hours of ['18:00–20:00', 'с 18:00 до 20:00']) {
        await result(
          f.submit('Пенёк, что обсуждали вчера ' + hours + '?'),
          'Ровно в шесть, Перед восьмью',
        );
        const sources = f.db
          .prepare(
            `SELECT m.platform_message_id FROM chat_summaries s
        JOIN chat_summary_sources cs ON cs.summary_id=s.id JOIN messages m ON m.id=cs.message_id
        WHERE s.chat_id=? AND s.level='day' AND s.starts_at=? AND s.ends_at=? ORDER BY m.id`,
          )
          .pluck()
          .all(chat, Date.UTC(2026, 10, 24, 15), Date.UTC(2026, 10, 24, 17));
        expect(sources).toEqual(['Ровно в шесть', 'Перед восьмью']);
      }
      await result(
        f.submit('Пенёк, что обсуждали вчера после 18:00?'),
        'Перед восьмью, Вечернее решение',
      );
      await result(f.submit('Пенёк, что обсуждали вчера до 18:00?'), 'Утреннее решение');
    } finally {
      await f.close();
    }
  },
);
test('точный интервал и неизвестная доставка промежуточного reply сохраняют один полезный результат', async () => {
  const f = await fixture();
  try {
    await appendSource(f, 'За пределами', -1);
    await appendSource(f, 'Нужное решение', 0);
    await appendSource(f, 'Верхняя граница', 1);
    f.failSend((text) => (text === 'собираю, минутку' ? 'unknownAfterDelivery' : undefined));
    f.complete.mockImplementation(async (request) => {
      expect(request.messages[0]!.text).toContain('Нужное решение');
      expect(request.messages[0]!.text).not.toMatch(/За пределами|Верхняя граница/u);
      return { ...answer, text: 'Нужное решение' };
    });
    const id = f.submit('[club314|Пенёк] Дай сводку с 2026-11-22T12:00Z по 2026-11-22T12:01Z');
    await until(() =>
      expect(
        f.sends.some(
          (row) =>
            row.text === 'Нужное решение' && row.reply_message?.conversation_message_id === id,
        ),
      ).toBe(true),
    );
    expect(f.sends.filter((row) => row.text === 'собираю, минутку')).toHaveLength(1);
    expect(f.db.prepare('SELECT delivered FROM chat_summary_notices').pluck().get()).toBe(0);
  } finally {
    await f.close();
  }
});

test('удаление источника после промежуточного reply удерживает текст пересказа', async () => {
  const f = await fixture();
  try {
    const source = await appendSource(f, 'Личное сообщение', 0);
    f.complete.mockImplementation(async () => {
      expect(f.sends.some((row) => row.text === 'собираю, минутку')).toBe(true);
      f.db.prepare('DELETE FROM messages WHERE id=?').run(source.id);
      return { ...answer, text: 'Закрытый текст' };
    });
    const id = f.submit(question);
    await until(async () =>
      expect((await f.trace(id)).payload.publication.status).not.toBe('pending_checks'),
    );
    expect(f.sends.filter((row) => row.text === 'Закрытый текст')).toHaveLength(0);
    expect(f.db.prepare('SELECT count(*) FROM chat_summaries').pluck().get()).toBe(0);
  } finally {
    await f.close();
  }
});

test('исчерпанная квота обращения останавливает пересказ до промежуточного reply', async () => {
  const f = await fixture({ userRequests: 1 });
  try {
    await appendSource(f, 'Решение для пересказа', 0);
    await f.published(f.submit('[club314|Пенёк] Ответь на вопрос.'));
    const recap = f.submit(question);
    expect((await f.trace(recap)).payload.resultKind).toBe('quota_exhausted');
    expect(f.sends.some(({ text }) => text === 'собираю, минутку')).toBe(false);
    expect(f.complete).toHaveBeenCalledOnce();
    expect(f.requests()).toBe(1);
  } finally {
    await f.close();
  }
});

test('при нехватке токенов пересказ сообщает о частичном покрытии, а пустой день обходится без модели', async () => {
  const f = await fixture({ summaryFragmentSize: 1 });
  try {
    const empty = f.submit(question);
    await until(() =>
      expect(
        f.sends.some(
          (row) =>
            row.reply_message?.conversation_message_id === empty &&
            row.text.includes('нет доступных'),
        ),
      ).toBe(true),
    );
    expect(f.complete).not.toHaveBeenCalled();
    await appendSource(f, 'Первое решение', 0);
    await appendSource(f, 'Второе решение', 1);
    tokenBudgetStore(f.storage).update(f.scope, true, { total: 2300 }, f.start);
    f.complete.mockResolvedValue({
      ...answer,
      text: 'Первое решение',
      usage: { input: 1200, output: 300 },
    });
    const id = f.submit(question);
    await until(() =>
      expect(
        f.sends.some(
          (row) =>
            row.reply_message?.conversation_message_id === id &&
            row.text.includes('часть переписки') &&
            row.text.includes('Первое решение'),
        ),
      ).toBe(true),
    );
    expect(f.complete).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

test.each(['receipt', 'unknown'])(
  'штатный порт с исходом %s ведёт служебный журнал по квитанции и сохраняет финальный пересказ',
  async (delivery) => {
    const f = await fixture();
    try {
      await appendSource(f, 'Подтверждённое решение', 0);
      const source = await f.storage.messages.append(f.scope, {
        chatId: chat,
        userId: 'vk:41',
        authorName: 'Ира',
        text: question,
        role: 'user',
        messageId: 'synthetic-question',
        timestamp: f.start,
      });
      const signal = new AbortController().signal;
      const service = applicationSummaries({
        storage: f.storage,
        model: 'synthetic',
        client: {
          async complete() {
            return { ...answer, text: 'Подтверждённое решение' };
          },
        },
        sessionSecret: 'synthetic',
        intervalMs: 300000,
        fragmentSize: 250,
        modelContext: 16000,
        inputBudget: 8000,
        signal,
        platform: 'vk',
        group: () => true,
        disclosure: () => 1,
        backgroundReady: () => true,
        port: {
          async canReply() {
            return true;
          },
          async publish() {
            if (delivery === 'unknown') throw Error('Квитанция недоступна');
            return {
              kind: 'delivered',
              receipt: {
                messageId: 'synthetic-status',
                userId: 'vk:314',
                authorName: 'Бот',
                timestamp: f.start,
              },
            };
          },
        },
      });
      const result = await service.answer({
        scope: f.scope,
        messageId: source.id,
        signal,
        route: { kind: 'mention', isGroupChat: true, mode: 'normal' },
        isCurrent: () => true,
        jobId: 1,
        recordTrace() {},
        admitModelAttempt: () => true,
      });
      expect(result?.result).toMatchObject({ kind: 'complete', text: 'Подтверждённое решение' });
      expect(f.db.prepare('SELECT delivered FROM chat_summary_notices').pluck().get()).toBe(
        delivery === 'receipt' ? 1 : 0,
      );
      expect(
        f.db
          .prepare("SELECT purpose FROM messages WHERE platform_message_id='synthetic-status'")
          .pluck()
          .get(),
      ).toBe(delivery === 'receipt' ? 'service_notice' : undefined);
    } finally {
      await f.close();
    }
  },
);

test(
  'период из прямого ответа даёт те же источники, что и период в полной просьбе',
  { timeout: 10_000 },
  async () => {
    const f = await fixture({
      startAt: Date.UTC(2026, 10, 25, 12),
      limit: 40,
      summaryIntervalMs: 999999999,
    });
    try {
      await f.storage.chats.update(f.scope, { timezone: 'Europe/Moscow' });
      for (const [name, time] of [
        ['РАНО', Date.UTC(2026, 10, 19, 20, 59, 59)],
        ['НАЧАЛО', Date.UTC(2026, 10, 19, 21)],
        ['КОНЕЦ', Date.UTC(2026, 10, 22, 20, 59, 59)],
        ['ПОЗДНО', Date.UTC(2026, 10, 22, 21)],
      ] as const)
        await f.storage.messages.append(f.scope, {
          chatId: chat,
          userId: 'vk:42',
          role: 'user',
          authorName: 'Ира',
          messageId: name,
          text: name,
          timestamp: time,
        });
      f.complete.mockResolvedValue({ ...answer, text: 'Итог выбранных дней.' });
      const replyTo = (id: number) =>
        f.sends.find(
          (row) =>
            row.reply_message?.conversation_message_id === id && row.text !== 'собираю, минутку',
        );
      const initial = f.submit('Пенёк, сделай сводку');
      await until(() => expect(replyTo(initial)?.text).toContain('За какой период'));
      const prompt = replyTo(initial)!;
      const pending = () => f.db.prepare('SELECT count(*) FROM recap_clarifications').pluck().get();
      await until(() => expect(pending()).toBe(1));
      await f.restart(true);
      const follow = f.submit('с двадцатого по двадцать второе ноября', 41, prompt);
      await until(() => expect(replyTo(follow)?.text).toContain('Итог выбранных дней.'));
      await until(() => expect(pending()).toBe(0));
      const calls = f.complete.mock.calls.length;
      const requests = JSON.stringify(f.complete.mock.calls);
      expect(requests).toContain('НАЧАЛО');
      expect(requests).toContain('КОНЕЦ');
      expect(requests).not.toMatch(/РАНО|ПОЗДНО/u);
      f.replay(follow);
      for (const form of [
        '20–22 ноября',
        'с 20-го по двадцать второе ноября',
        '20.11.2026–22.11.2026',
        '2026-11-20 — 2026-11-22',
      ]) {
        const id = f.submit('Пенёк, что было ' + form + '?');
        await until(() => expect(replyTo(id)?.text).toContain('Итог выбранных дней.'));
        const again = f.submit('Пенёк, сделай сводку');
        await until(() => expect(pending()).toBe(1));
        const short = f.submit(form, 41, replyTo(again)!);
        await until(() => expect(replyTo(short)?.text).toContain('Итог выбранных дней.'));
        await until(() => expect(pending()).toBe(0));
      }
      expect(f.complete.mock.calls).toHaveLength(calls);
    } finally {
      await f.close();
    }
  },
);

test('автор может ответить на доставленное уточнение, даже если VK не смог прикрепить его к просьбе', async () => {
  const f = await fixture();
  try {
    await appendSource(f, 'Вчера договорились о встрече.', 0);
    f.complete.mockResolvedValue({ ...answer, text: 'Договорились о встрече.' });
    const initial = f.submit('Пенёк, сделай сводку');
    f.hideVkMessage(initial);
    const prompt = () => f.sends.find((row) => row.text.includes('За какой период'));
    await until(() => expect(prompt()).toBeDefined());
    expect(prompt()!.reply_message).toBeUndefined();
    await until(() =>
      expect(f.db.prepare('SELECT count(*) FROM recap_clarifications').pluck().get()).toBe(1),
    );
    const follow = f.submit('вчера', 41, prompt()!);
    await until(() =>
      expect(
        f.sends.find(
          (row) =>
            row.reply_message?.conversation_message_id === follow &&
            row.text === 'Договорились о встрече.',
        ),
      ).toBeDefined(),
    );
  } finally {
    await f.close();
  }
});

test.each([
  [
    'после обеда',
    'После какого времени',
    '18:00',
    'после 18:00',
    'Перед восьмью, Вечернее решение',
  ],
  ['18:00–', 'До какого времени', '20:00', '18:00–20:00', 'Ровно в шесть, Перед восьмью'],
])(
  'ответ для «вчера %s» после полуночи и перезапуска использует исходный пояс',
  async (incomplete, hint, time, full, expected) => {
    const f = await fixture({
      startAt: Date.UTC(2026, 10, 25, 20, 59, 59),
      limit: 40,
      summaryIntervalMs: 999999999,
    });
    try {
      const result = await seedClockHistory(f);
      const count = () => f.db.prepare('SELECT count(*) FROM recap_clarifications').pluck().get();
      const request = f.submit('Пенёк, что обсуждали вчера ' + incomplete + '?');
      await until(() => expect(count()).toBe(1));
      const prompt = f.sends.find((row) => row.reply_message?.conversation_message_id === request)!;
      expect(prompt.text).toContain(hint);
      if (incomplete === '18:00–')
        expect(f.db.prepare('SELECT known_from FROM recap_clarifications').pluck().get()).toBe(
          Date.UTC(2026, 10, 24, 15),
        );
      expect(f.complete).not.toHaveBeenCalled();
      await f.published(f.submit(time, 42, prompt));
      expect(count()).toBe(1);
      await result(f.submit('Пенёк, что обсуждали вчера ' + full + '?'), expected);
      await appendSource(f, 'Сообщение записали после просьбы о пересказе', -240);
      await f.restart(true);
      f.at(2000);
      await f.storage.chats.update(f.scope, { timezone: 'UTC' });
      const calls = f.complete.mock.calls.length;
      const reply = f.submit(time, 41, prompt);
      await result(reply, expected);
      await until(() => expect(count()).toBe(0));
      f.replay(reply);
      await f.journaled(f.submit('спасибо'));
      expect(f.complete.mock.calls).toHaveLength(calls);
      expect(
        f.sends.filter((row) => row.reply_message?.conversation_message_id === reply),
      ).toHaveLength(1);
      const next = f.submit('Пенёк, что обсуждали вчера до обеда?');
      await until(() => expect(count()).toBe(1));
      const before = f.sends.find((row) => row.reply_message?.conversation_message_id === next)!;
      expect(before.text).toContain('До какого времени');
      await result(f.submit('24.11.2026 с 05:59 до 06:01', 41, before), 'Утреннее решение');
      await until(() => expect(count()).toBe(0));
    } finally {
      await f.close();
    }
  },
);

test('уточнение привязано к сообщению и автору, недостающую границу можно прислать отдельно', async () => {
  const f = await fixture();
  try {
    const count = () => f.db.prepare('SELECT count(*) FROM recap_clarifications').pluck().get();
    const reply = (id: number) =>
      f.sends.find((row) => row.reply_message?.conversation_message_id === id);
    const a = f.submit('Пенёк, что было с 20 ноября?');
    const b = f.submit('Пенёк, сделай сводку', 42);
    await until(() => expect(count()).toBe(2));
    expect(reply(a)?.text).toContain('По какую дату');
    expect(reply(b)?.text).toContain('За какой период');
    const other = f.submit('вчера', 42, reply(a)!);
    await f.published(other);
    expect(count()).toBe(2);
    const first = f.submit('по 22 ноября', 41, reply(a)!);
    await f.published(first);
    await until(() => expect(count()).toBe(1));
    const second = f.submit('вчера', 42, reply(b)!);
    await f.published(second);
    await until(() => expect(count()).toBe(0));
  } finally {
    await f.close();
  }
});

test('после полуночи «вчера» относится ко дню ответа, а граница истории остаётся у исходной просьбы', async () => {
  const f = await fixture({ startAt: Date.UTC(2026, 10, 24, 20, 59, 59) });
  try {
    const neighbor = await f.connectGroup(peer + 1);
    await f.storage.chats.update(f.scope, { timezone: 'Europe/Moscow' });
    const source = (text: string, timestamp: number) =>
      f.storage.messages.append(f.scope, {
        chatId: chat,
        userId: 'vk:42',
        role: 'user',
        authorName: 'Ира',
        messageId: text,
        text,
        timestamp,
      });
    await source('Сообщение за двадцать третье', f.start - 86400000);
    await source('Решение от двадцать четвёртого', f.start - 30_000);
    f.complete.mockResolvedValue({ ...answer, text: 'Вчера приняли решение.' });
    const request = f.submit('Пенёк, сделай сводку');
    const pending = () => f.db.prepare('SELECT count(*) FROM recap_clarifications').pluck().get();
    await until(() => expect(pending()).toBe(1));
    const prompt = f.sends.find((row) => row.reply_message?.conversation_message_id === request)!;
    await source('Запись после первоначальной просьбы', f.start);
    await f.journaled(f.submit('вчера'));
    const outside = f.submit('вчера', 41, prompt, peer + 1);
    await until(async () =>
      expect(
        (await f.storage.messages.list(neighbor, { limit: 10 })).some(
          (m) => m.messageId === String(outside),
        ),
      ).toBe(true),
    );
    expect(pending()).toBe(1);
    await f.restart(true, [peer + 1]);
    f.at(2000);
    const reply = f.submit('вчера', 41, prompt);
    await until(() =>
      expect(
        f.sends.some(
          (row) =>
            row.reply_message?.conversation_message_id === reply &&
            row.text === 'Вчера приняли решение.',
        ),
      ).toBe(true),
    );
    expect(pending()).toBe(0);
    const calls = JSON.stringify(f.complete.mock.calls);
    expect(calls).toContain('Решение от двадцать четвёртого');
    expect(calls).not.toMatch(/Сообщение за двадцать третье|Запись после первоначальной просьбы/u);
  } finally {
    await f.close();
  }
});

test('месяц уточняется после перезапуска, неизвестная доставка и удалённая просьба не открывают продолжение', async () => {
  const app = await fixture();
  try {
    const prompts = () => app.db.prepare('SELECT count(*) FROM recap_clarifications').pluck().get();
    const reply = (id: number) =>
      app.sends.find((row) => row.reply_message?.conversation_message_id === id);
    app.failSend((text) => (text.includes('В каком месяце') ? 'unknownAfterDelivery' : undefined));
    const failed = app.submit('Пенёк, что было с 20 по 22?');
    await app.published(failed);
    app.failSend(undefined);
    const valid = app.submit('Пенёк, что было с 20 по 22?');
    await until(() => {
      expect(reply(valid)?.text).toContain('В каком месяце');
      expect(prompts()).toBe(1);
    });
    await app.restart(true);
    const answer = app.submit('в ноябре', 41, reply(valid)!);
    await app.published(answer);
    await until(() => expect(prompts()).toBe(0));
    const remove = app.submit('Пенёк, сделай сводку');
    await until(() => expect(prompts()).toBe(1));
    app.db
      .prepare('DELETE FROM messages WHERE chat_id=? AND platform_message_id=?')
      .run(chat, String(remove));
    expect(prompts()).toBe(0);
  } finally {
    await app.close();
  }
});
