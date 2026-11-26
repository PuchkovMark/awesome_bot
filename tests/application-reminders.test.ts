import { splitVkText } from '../src/channels/vk/outbound-text';
import { expect, test } from 'vitest';
import { mention, peer, remindersFixture, until } from './helpers/application-reminders-fixture';

const direct = '[club314|Пенёк] ';
const minute = 60_000;
const future = Date.UTC(2026, 10, 24, 15);
const recoveryHint = 'Проверить напоминание можно в личке по команде «Мои напоминания».';

test('после отказа повтор по номеру отправляет только оставшуюся часть с прежним ключом', async () => {
  const f = await remindersFixture();
  const ending = 'уникальная концовка подтверждения';
  const text = 'а'.repeat(2400) + ' ' + ending;
  try {
    f.refuseOnce(ending);
    const original = f.send(direct + 'Напомни мне через 1 минуту ' + text, 41, peer);
    await until(() => expect(f.sends.find((row) => row.peer_id === peer)?.text).toBe(recoveryHint));
    const item = f.pending()[0]!;
    const parts = f.db
      .prepare(
        `SELECT send_id AS sendId,state,definite_failure AS failed FROM personal_reminder_parts
       WHERE reminder_id=? AND stage='confirmation' ORDER BY part`,
      )
      .all(item.id) as { sendId: number; state: string; failed: number }[];
    const failed = parts.at(-1)!;
    expect(parts.length).toBeGreaterThan(1);
    expect(
      parts.slice(0, -1).every(({ state, failed }) => state === 'confirmed' && failed === 0),
    ).toBe(true);
    expect(failed).toMatchObject({ state: 'ready', failed: 1 });
    const requests = () =>
      f.attempt.mock.calls
        .filter(
          ([method, args]) =>
            method === 'messages.send' &&
            parts.some((part) => part.sendId === Number(args.random_id)),
        )
        .map(([, args]) => Number(args.random_id));

    f.repeat(original);
    f.send('Мои напоминания');
    await until(() =>
      expect(
        f.sends.some(
          (row) => row.peer_id === 41 && row.text.includes(`Повтори подтверждение #${item.id}`),
        ),
      ).toBe(true),
    );
    expect(requests()).toEqual(parts.map(({ sendId }) => sendId));

    const before = f.sends.length;
    f.send(`Повтори подтверждение #${item.id}`);
    await until(() =>
      expect(
        f.db.prepare('SELECT confirmation FROM personal_reminders WHERE id=?').pluck().get(item.id),
      ).toBe('delivered'),
    );
    expect(requests()).toEqual([...parts.map(({ sendId }) => sendId), failed.sendId]);
    expect(f.sends.slice(before)).toEqual([
      expect.objectContaining({
        peer_id: 41,
        random_id: failed.sendId,
        text: expect.stringContaining(ending),
      }),
    ]);
    expect(f.sends.filter(({ peer_id }) => peer_id === peer).map(({ text }) => text)).toEqual([
      recoveryHint,
    ]);
    expect(f.pending()).toEqual([item]);
    expect(f.complete).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

test.each(['скрытая квитанция', 'потеря ответа'] as const)(
  'проверка после исхода «%s» не отправляет подтверждение снова',
  async (fault) => {
    const f = await remindersFixture();
    const prefix = 'Напомню вам';
    try {
      if (fault === 'скрытая квитанция') f.hide(prefix);
      else f.lost(prefix);
      const original = f.send(direct + 'Напомни мне через 1 минуту взять билет', 41, peer);
      await until(() =>
        expect(f.sends.find((row) => row.peer_id === peer)?.text).toBe(recoveryHint),
      );
      const item = f.pending()[0]!;
      const confirmation = f.sends.find(({ text }) => text.startsWith(prefix))!;
      const requests = () =>
        f.attempt.mock.calls.filter(
          ([method, args]) => method === 'messages.send' && String(args.message).startsWith(prefix),
        ).length;
      const reads = () =>
        f.attempt.mock.calls.filter(
          ([method, args]) =>
            method === 'messages.getByConversationMessageId' &&
            args.peer_id === 41 &&
            args.conversation_message_ids === String(confirmation.conversation_message_id),
        ).length;
      const beforeReads = reads();
      let sentBefore = f.sends.length;
      f.repeat(original);
      f.send(`Проверь напоминание #${item.id}`);
      await until(() =>
        expect(f.sends.slice(sentBefore).at(-1)).toMatchObject({
          peer_id: 41,
          text: expect.stringMatching(
            new RegExp(
              `^Напоминание #${item.id} назначено на .*Доставка подтверждения неизвестна\\.$`,
              'u',
            ),
          ),
        }),
      );
      expect(requests()).toBe(1);
      expect(reads()).toBeGreaterThanOrEqual(beforeReads);
      if (fault === 'скрытая квитанция') {
        expect(reads()).toBeGreaterThan(beforeReads);
        f.reveal();
        sentBefore = f.sends.length;
        f.send(`Проверь напоминание #${item.id}`);
        await until(() =>
          expect(f.sends.slice(sentBefore).at(-1)).toMatchObject({
            peer_id: 41,
            text: expect.stringContaining('Подтверждение доставлено.'),
          }),
        );
      } else {
        expect(reads()).toBe(beforeReads);
      }
      expect(requests()).toBe(1);
      expect(f.pending()).toEqual([item]);
      expect(f.sends.filter(({ peer_id }) => peer_id === peer).map(({ text }) => text)).toEqual([
        recoveryHint,
      ]);
      expect(f.complete).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  },
);

test('при сверке первой части подтверждения готовая вторая часть остаётся без отправки', async () => {
  const f = await remindersFixture();
  const ending = 'конец второго фрагмента';
  try {
    f.hide('Напомню вам');
    f.send(direct + 'Напомни мне через 1 минуту ' + 'а'.repeat(2400) + ' ' + ending, 41, peer);
    await until(() => expect(f.sends.find((row) => row.peer_id === peer)?.text).toBe(recoveryHint));
    const id = f.pending()[0]!.id;
    f.reveal();
    f.send(`Проверь напоминание #${id}`);
    await until(() => expect(f.sends.at(-1)?.text).toContain('Доставка подтверждения неизвестна.'));
    expect(f.sends.some(({ text }) => text.includes(ending))).toBe(false);
    const states = f.db
      .prepare(
        "SELECT state FROM personal_reminder_parts WHERE reminder_id=? AND stage='confirmation' ORDER BY part",
      )
      .pluck()
      .all(id);
    expect(states.length).toBeGreaterThan(1);
    expect(states[0]).toBe('confirmed');
    expect(states.slice(1).every((state) => state === 'ready')).toBe(true);
    expect(f.complete).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

test.each(['отказ', 'потеря ответа'] as const)(
  'та же просьба после сбоя «%s» и перезапуска сохраняет номер и одну доставку в 12:01 UTC',
  async (fault) => {
    const f = await remindersFixture(Date.UTC(2026, 10, 25, 12));
    const request = direct + 'Напомни мне через 1 минуту взять билет';
    const dueAt = f.origin + minute;
    const confirmations = () => f.sends.filter(({ text }) => text.startsWith('Напомню вам'));
    try {
      if (fault === 'отказ') f.refuseOnce('взять билет');
      else f.lost('Напомню вам');
      const original = f.send(request, 41, peer);
      await until(() =>
        expect(f.sends.find((row) => row.peer_id === peer)?.text).toBe(recoveryHint),
      );
      const item = f.pending()[0]!;
      expect(item).toMatchObject({ dueAt, chatId: 'vk:41', text: 'взять билет' });
      expect(confirmations()).toHaveLength(fault === 'отказ' ? 0 : 1);

      f.at(f.origin + 20_000);
      const repeated = f.send(request, 41, peer);
      await until(() =>
        expect(f.sends.at(-1)).toMatchObject({
          peer_id: 41,
          text: expect.stringContaining(
            `Напоминание #${item.id} назначено на 25 ноября 2026 г. в 12:01 (UTC).`,
          ),
        }),
      );
      expect(f.pending()).toEqual([item]);
      expect(
        f.db
          .prepare(
            'SELECT event_id AS event,reminder_id AS id FROM personal_reminder_inputs ORDER BY CAST(event_id AS INTEGER)',
          )
          .all(),
      ).toEqual(
        [original, repeated].map(({ conversation_message_id }) => ({
          event: String(conversation_message_id),
          id: item.id,
        })),
      );
      expect(confirmations()).toHaveLength(fault === 'отказ' ? 0 : 1);

      await f.halt();
      await f.launch();
      await f.resolve('vk:41');
      await f.resolve(`vk:${peer}`);
      f.repeat(original);
      f.repeat(repeated);
      f.send('Мои напоминания');
      const action = fault === 'отказ' ? 'Повтори подтверждение' : 'Проверь напоминание';
      await until(() => expect(f.sends.at(-1)?.text).toContain(`${action} #${item.id}`));
      f.send(`${action} #${item.id}`);
      await until(() =>
        expect(f.sends.at(-1)?.text).toContain(
          fault === 'отказ' ? 'Напомню вам' : 'Доставка подтверждения неизвестна.',
        ),
      );
      expect(f.pending()).toEqual([item]);
      f.at(dueAt);
      await until(() =>
        expect(f.pending()[0]).toMatchObject({ id: item.id, state: 'delivered', dueAt }),
      );
      expect(confirmations()).toEqual([expect.objectContaining({ peer_id: 41 })]);
      expect(f.sends.filter(({ text }) => text === 'Напоминание.\nвзять билет')).toEqual([
        expect.objectContaining({ peer_id: 41, date: dueAt / 1_000 }),
      ]);
      expect(f.sends.filter(({ peer_id }) => peer_id === peer).map(({ text }) => text)).toEqual([
        recoveryHint,
      ]);
      expect(f.complete).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  },
);

test('календарная просьба совпадает по дню, времени и поясу, а другой срок создаёт свою запись', async () => {
  const f = await remindersFixture(Date.UTC(2026, 10, 25, 12));
  const dueAt = Date.UTC(2026, 10, 26, 15);
  try {
    f.refuseOnce('взять билет');
    f.send(direct + 'Напомни мне завтра в 18:00 по Москве взять билет', 41, peer);
    await until(() => expect(f.sends.at(-1)?.text).toBe(recoveryHint));
    const item = f.pending()[0]!;
    f.at(f.origin + 20_000);
    f.send('Напомни мне 26.11.2026 в 18:00 Europe/Moscow взять билет');
    await until(() => expect(f.sends.at(-1)?.text).toContain(`Повтори подтверждение #${item.id}`));
    expect(f.pending()).toEqual([item]);

    f.send('Напомни мне 26.11.2026 в 18:00 Asia/Riyadh взять билет');
    f.send('Напомни мне 26.11.2026 в 18:01 Europe/Moscow взять билет');
    f.send('Напомни мне 27.11.2026 в 18:00 Europe/Moscow взять билет');
    await until(() =>
      expect(f.sends.filter(({ text }) => text.startsWith('Напомню вам'))).toHaveLength(3),
    );
    expect(f.pending()).toEqual([
      expect.objectContaining({ id: item.id, dueAt, timezone: 'Europe/Moscow' }),
      expect.objectContaining({ dueAt, timezone: 'Asia/Riyadh' }),
      expect.objectContaining({ dueAt: dueAt + minute, timezone: 'Europe/Moscow' }),
      expect.objectContaining({ dueAt: dueAt + 24 * 60 * minute, timezone: 'Europe/Moscow' }),
    ]);
    expect(f.complete).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

test('копия и восстановление остаются в личке автора при одинаковых номерах сообщений в двух беседах', async () => {
  const f = await remindersFixture(Date.UTC(2026, 10, 25, 12));
  const secondPeer = peer + 1;
  const dueAt = f.origin + minute;
  async function ask(input: string, user = 41) {
    const index = f.sends.length;
    const event = f.send(input, user);
    await until(() => expect(f.sends[index]?.peer_id).toBe(user));
    return { event, text: f.sends[index]!.text };
  }
  try {
    await f.readyGroup(secondPeer);
    f.sends.length = 0;
    const parentA = f.send('Реплика в первой беседе.', 42, peer, f.origin, undefined, 40_001);
    const parentB = f.send(
      'Реплика во второй беседе.',
      41,
      secondPeer,
      f.origin,
      undefined,
      40_001,
    );
    f.refuseOnce('взять билет');
    const originalA = f.send(
      direct + 'Напомни мне через 1 минуту взять билет',
      41,
      peer,
      f.origin,
      parentA,
      40_002,
    );
    await until(() => expect(f.sends.at(-1)).toMatchObject({ peer_id: peer, text: recoveryHint }));
    f.refuseOnce('забрать ключи');
    const originalB = f.send(
      direct + 'Напомни мне через 1 минуту забрать ключи',
      42,
      secondPeer,
      f.origin,
      parentB,
      40_002,
    );
    await until(() =>
      expect(f.sends.at(-1)).toMatchObject({ peer_id: secondPeer, text: recoveryHint }),
    );
    const [a, b] = f.pending();
    expect(a).toMatchObject({ chatId: 'vk:41', text: 'взять билет', dueAt });
    expect(b).toMatchObject({ chatId: 'vk:42', text: 'забрать ключи', dueAt });
    expect(originalA.conversation_message_id).toBe(originalB.conversation_message_id);
    const aId = a!.id;
    const bId = b!.id;
    for (const cmd of ['Проверь напоминание', 'Повтори подтверждение', 'Создать ещё одно']) {
      expect((await ask(`${cmd} #${aId}`, 42)).text).toBe('Напоминание не найдено.');
    }
    const listed = (await ask('Мои напоминания')).text;
    expect(listed).toContain(`Копия на тот же срок.\nСоздать ещё одно #${aId}`);
    expect(listed).not.toContain('забрать ключи');

    const copied = await ask(`Создать ещё одно #${aId}`);
    const copy = f.pending().find(({ id }) => id !== aId && id !== bId)!;
    expect(copy).toMatchObject({ chatId: 'vk:41', dueAt, timezone: a!.timezone, text: a!.text });
    expect(copied.text).toContain(`Копия #${copy.id}.`);
    f.repeat(copied.event);
    for (const original of [originalA, originalB]) f.repeat(original);
    const listA = (await ask('Мои напоминания')).text;
    expect(listA).toContain(`#${aId} ·`);
    expect(listA).toContain(`#${copy.id} ·`);
    const listB = (await ask('Мои напоминания', 42)).text;
    expect(listB).toContain(`#${bId} ·`);
    expect(listB).not.toContain('взять билет');
    expect(f.pending()).toHaveLength(3);
    expect((await ask(`Повтори подтверждение #${aId}`)).text).toContain('взять билет');
    expect((await ask(`Повтори подтверждение #${bId}`, 42)).text).toContain('забрать ключи');
    const confirmations = f.sends.filter(({ text }) => text.startsWith('Напомню вам'));
    expect(confirmations.map(({ peer_id, text }) => [peer_id, text.split('\n').at(-1)])).toEqual([
      [41, 'взять билет'],
      [41, 'взять билет'],
      [42, 'забрать ключи'],
    ]);
    expect(new Set(confirmations.map(({ random_id }) => random_id)).size).toBe(3);
    f.at(dueAt);
    await until(() =>
      expect(f.pending().map(({ state }) => state)).toEqual([
        'delivered',
        'delivered',
        'delivered',
      ]),
    );
    const deliveries = f.sends.filter(({ text }) => text.startsWith('Напоминание.\n'));
    expect(deliveries.map(({ peer_id, text, date }) => [peer_id, text, date])).toEqual([
      [41, 'Напоминание.\nвзять билет', dueAt / 1_000],
      [42, 'Напоминание.\nзабрать ключи', dueAt / 1_000],
      [41, 'Напоминание.\nвзять билет', dueAt / 1_000],
    ]);
    expect(new Set([...confirmations, ...deliveries].map(({ random_id }) => random_id)).size).toBe(
      6,
    );
    for (const destination of [peer, secondPeer]) {
      expect(
        f.sends.filter(({ peer_id }) => peer_id === destination).map(({ text }) => text),
      ).toEqual([recoveryHint]);
    }
    expect(f.complete).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

test('копирование закрывается в момент срока, после отмены и при смене поколения лички', async () => {
  const f = await remindersFixture();
  async function ask(input: string) {
    const index = f.sends.length;
    f.send(input);
    await until(() => expect(f.sends[index]?.peer_id).toBe(41));
    return f.sends[index]!.text;
  }
  try {
    await ask('Напомни мне через 1 минуту проверить почту');
    await ask('Напомни мне через 5 минут забрать заказ');
    const first = f.pending()[0]!.id;
    const second = f.pending()[1]!.id;
    expect(await ask(`Отмени напоминание #${second}`)).toContain('отменено');
    expect(await ask(`Создать ещё одно #${second}`)).toContain('отменено');
    f.hold();
    f.at(f.origin + minute);
    await until(() => expect(f.holds).toHaveLength(1));
    expect(await ask(`Создать ещё одно #${first}`)).toContain('отправьте просьбу с новым сроком');
    expect(f.pending().map(({ id }) => id)).toEqual([first, second]);
    f.holds.shift()?.();
    await until(() => expect(f.pending()[0]?.state).toBe('delivered'));
    const old = f.life.current('vk:41');
    const next = await f.resolve('vk:41', 'new');
    expect(next.generation).not.toBe(old.generation);
    expect(await ask(`Создать ещё одно #${first}`)).toBe('Напоминание не найдено.');
    expect(await ask(`Проверь напоминание #${second}`)).toBe('Напоминание не найдено.');
    expect(f.pending()).toEqual([]);
    expect(f.complete).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

test('задержанная сверка подтверждения пропускает доставку в срок и показывает её исход', async () => {
  const f = await remindersFixture();
  const dueAt = f.origin + minute;
  try {
    f.hide('Напомню вам');
    f.send('Напомни мне через 1 минуту взять билет');
    await until(() =>
      expect(f.db.prepare('SELECT confirmation FROM personal_reminders').pluck().get()).toBe(
        'unknown',
      ),
    );
    const id = f.pending()[0]!.id;
    const confirmed = f.sends[0]!;
    const reads = () =>
      f.attempt.mock.calls.filter(
        ([method, args]) =>
          method === 'messages.getByConversationMessageId' &&
          args.peer_id === 41 &&
          args.conversation_message_ids === String(confirmed.conversation_message_id),
      ).length;
    f.reveal();
    const countBefore = reads();
    const release = f.holdRead(41, confirmed.conversation_message_id);
    f.send(`Проверь напоминание #${id}`);
    await until(() => expect(reads()).toBe(countBefore + 1));
    f.at(dueAt);
    await until(() => expect(f.pending()[0]?.state).toBe('delivered'));
    expect(f.sends.slice(1)).toEqual([
      expect.objectContaining({
        peer_id: 41,
        text: 'Напоминание.\nвзять билет',
        date: dueAt / 1_000,
      }),
    ]);
    release();
    await until(() =>
      expect(f.sends.at(-1)).toMatchObject({
        peer_id: 41,
        text: expect.stringMatching(/^#\d+ .* · доставлено$/u),
      }),
    );
    expect(f.sends.filter(({ text }) => text.startsWith('Напомню вам'))).toHaveLength(1);
    expect(f.complete).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

test('личный выбор отмены показывает реальные номера и ждёт команды даже при одном задании', async () => {
  const f = await remindersFixture();
  async function ask(text: string, user = 41) {
    const index = f.sends.length;
    f.send(text, user);
    await until(() => expect(f.sends[index]?.peer_id).toBe(user));
    return f.sends[index]!.text;
  }
  try {
    const choose = 'Отмени напоминание';
    expect(await ask(choose)).toBe('Сейчас нечего отменять.');
    await ask('Напомни мне через 1 час прочитать письмо', 42);
    await ask('Напомни мне через 2 часа забрать ключи');
    const id = f.pending().find((r) => r.text === 'забрать ключи')!.id;
    expect(id).toBeGreaterThan(1);
    const single = await ask(choose);
    expect(single).toContain('забрать ключи');
    expect(single).toContain('UTC');
    expect(single).toContain(choose + ' ' + id);
    expect(single).not.toContain('прочитать письмо');
    await ask('Напомни мне вечером забрать книгу');
    const draft = f.pending().find((r) => r.text === 'забрать книгу')!.id;
    const options = await ask(choose);
    expect(options).toContain(single);
    expect(options).toContain('Черновик · забрать книгу');
    expect(options).toContain(choose + ' ' + draft);
    expect(await ask(options.split('\n').find((line) => line === choose + ' ' + id)!)).toContain(
      'отменено',
    );
    expect(f.pending().map((r) => r.state)).toEqual(['pending', 'cancelled', 'draft']);
    expect(await ask(choose)).not.toContain('забрать ключи');
    expect(f.complete).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

test.each([
  {
    input: '27 ноября в 18:00 по Москве забрать посылку',
    task: 'забрать посылку',
    timezone: 'Europe/Moscow',
    label: '27 ноября 2026 г. в 18:00 (Europe/Moscow)',
    dueAt: Date.UTC(2026, 10, 27, 15),
    before: Date.UTC(2026, 10, 25, 15),
  },
  {
    input: 'завтра в 18:00 UTC+3 забрать документы',
    task: 'забрать документы',
    timezone: '+03:00',
    label: '26 ноября 2026 г. в 18:00 (+03:00)',
    dueAt: Date.UTC(2026, 10, 26, 15),
    after: Date.UTC(2026, 10, 26, 18),
  },
  {
    input: 'через 20 минут отправить ссылку https://example.org/docs',
    task: 'отправить ссылку https://example.org/docs',
    timezone: 'UTC',
    label: '25 ноября 2026 г. в 12:20 (UTC)',
    dueAt: Date.UTC(2026, 10, 25, 12, 20),
  },
])('личное напоминание «$input» приходит в срок с полным поручением', async (scenario) => {
  const f = await remindersFixture(Date.UTC(2026, 10, 25, 12));
  const deliveries = () =>
    f.sends
      .filter(({ text }) => text.startsWith('Напоминание.\n'))
      .map(({ peer_id, text }) => [peer_id, text]);
  async function showList(at: number) {
    f.at(at);
    const since = f.sends.length;
    f.send('Мои напоминания');
    await until(() =>
      expect(f.sends.slice(since).some(({ text }) => text.includes(scenario.label))).toBe(true),
    );
  }
  try {
    f.send('Напомни мне ' + scenario.input);
    await until(() => expect(f.sends.at(-1)?.text).toContain('Напомню вам'));
    expect(f.sends.at(-1)).toMatchObject({
      peer_id: 41,
      text: 'Напомню вам в этой личке ' + scenario.label + '.\n' + scenario.task,
    });
    expect(f.pending()).toEqual([
      expect.objectContaining({
        state: 'pending',
        dueAt: scenario.dueAt,
        text: scenario.task,
        timezone: scenario.timezone,
      }),
    ]);
    await showList(scenario.before ?? scenario.dueAt - 1);
    expect(deliveries()).toEqual([]);
    f.at(scenario.dueAt);
    await until(() => expect(f.pending()[0]?.state).toBe('delivered'));
    await showList(scenario.after ?? scenario.dueAt + minute);
    expect(deliveries()).toEqual([[41, 'Напоминание.\n' + scenario.task]]);
    expect(f.complete).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

test('уточнение времени сохраняет известную дату и поручение со ссылкой', async () => {
  const f = await remindersFixture(Date.UTC(2026, 10, 25, 12));
  const task = 'отправить ссылку https://example.org/docs';
  try {
    f.send('Напомни мне 27 ноября по Москве ' + task);
    await until(() => expect(f.pending()[0]).toMatchObject({ state: 'draft', text: task }));
    const id = f.pending()[0]!.id;
    await until(() =>
      expect(f.sends.at(-1)?.text).toContain('уточни напоминание #' + id + ' 18:00»'),
    );
    f.send('Уточни напоминание #' + id + ' 18:00');
    await until(() => expect(f.sends.at(-1)?.text).toContain('Напомню вам'));
    expect(f.pending()[0]).toMatchObject({
      state: 'pending',
      dueAt: Date.UTC(2026, 10, 27, 15),
      text: task,
    });
  } finally {
    await f.close();
  }
});

test.each(['2', '#2', undefined])(
  'уточнение с номером %s назначает срок черновику и сохраняет уже назначенное задание',
  async (number) => {
    const f = await remindersFixture(Date.UTC(2026, 10, 25, 12));
    try {
      f.send('Напомни мне через 20 минут проверить почту');
      await until(() => expect(f.sends.at(-1)?.text).toContain('Напомню вам'));
      f.send('Напомни мне завтра взять паспорт');
      await until(() => expect(f.sends.at(-1)?.text).toContain('Для напоминания #2'));
      const before = f.pending();
      expect(before).toEqual([
        expect.objectContaining({ id: 1, state: 'pending', dueAt: f.origin + 20 * minute }),
        expect.objectContaining({ id: 2, state: 'draft', dueAt: null }),
      ]);
      f.send('Уточни напоминание 1 завтра в 18:00 по Москве');
      await until(() => expect(f.sends.at(-1)?.text).toBe('Напоминание #1 не ждёт уточнения.'));
      expect(f.pending()).toEqual(before);

      const prefix = 'Уточни напоминание' + (number === undefined ? '' : ' ' + number);
      f.send(prefix + ' завтра в 18:00 по Москве');
      await until(() =>
        expect(f.sends.at(-1)).toMatchObject({
          peer_id: 41,
          text: 'Напомню вам в этой личке 26 ноября 2026 г. в 18:00 (Europe/Moscow).\nвзять паспорт',
        }),
      );
      expect(f.pending()).toEqual([
        before[0],
        expect.objectContaining({
          id: 2,
          state: 'pending',
          dueAt: Date.UTC(2026, 10, 26, 15),
          text: 'взять паспорт',
        }),
      ]);
    } finally {
      await f.close();
    }
  },
);

test.each([
  [41, 'Напомни мне через 20 минут взять документы'],
  [peer, 'Пенёк, напомни мне через 20 минут взять документы'],
] as const)(
  'копия строки справки в диалоге %d создаёт ровно одно личное напоминание',
  async (chat, example) => {
    const f = await remindersFixture();
    try {
      if (chat === peer) await f.readyGroup(peer);
      f.send('/помощь напоминания', 41, chat);
      const help = () =>
        f.sends.find(
          ({ peer_id, text }) => peer_id === chat && text.startsWith('Личные напоминания'),
        );
      await until(() => expect(help()).toBeDefined());
      const lines = help()!.text.split('\n');
      const copied = lines.find((line) => /^(?:Пенёк, )?напомни мне /iu.test(line));
      expect(copied).toBe(example);
      expect(lines).toContain('Напоминание придёт в личку.');

      f.send(copied!, 41, chat);
      const confirmations = () => f.sends.filter(({ text }) => text.startsWith('Напомню вам'));
      await until(() => expect(confirmations()).toHaveLength(1));
      expect(confirmations()[0]).toMatchObject({
        peer_id: 41,
        text: expect.stringMatching(/\nвзять документы$/u),
      });
      expect(f.pending()).toEqual([
        expect.objectContaining({
          chatId: 'vk:41',
          state: 'pending',
          dueAt: f.origin + 20 * minute,
          text: 'взять документы',
        }),
      ]);
      f.at(f.origin + 20 * minute);
      await until(() => expect(f.pending()[0]?.state).toBe('delivered'));
      expect(
        f.sends
          .filter(({ text }) => text.startsWith('Напоминание.\n'))
          .map(({ peer_id, text }) => [peer_id, text]),
      ).toEqual([[41, 'Напоминание.\nвзять документы']]);
      expect(confirmations()).toHaveLength(1);
      expect(f.complete).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  },
);

test.each([
  ['завтра забрать посылку в 18:00 по Москве', Date.UTC(2026, 10, 26, 15)],
  ['завтра в 18:00 по Москве забрать посылку', Date.UTC(2026, 10, 26, 15)],
  ['27.11.2026 забрать посылку в 18:00 по Москве', Date.UTC(2026, 10, 27, 15)],
  ['27.11.2026 в 18:00 по Москве забрать посылку', Date.UTC(2026, 10, 27, 15)],
  ['через 1 час 30 минут забрать посылку', Date.UTC(2026, 10, 25, 13, 30)],
  ['через 1 час и ещё несколько минут забрать посылку', Date.UTC(2026, 10, 25, 13, 30)],
  ['через 1 час или через 2 часа забрать посылку', Date.UTC(2026, 10, 25, 14)],
] as const)('подтверждение и доставка для «%s»', async (input, dueAt) => {
  const f = await remindersFixture(Date.UTC(2026, 10, 25, 12));
  try {
    f.send('Напомни мне ' + input);
    if (input.includes(' или ') || input.includes('несколько')) {
      await until(() => expect(f.sends.at(-1)?.text).toContain('выберите один срок'));
      const draft = f.pending()[0]!;
      expect(draft).toMatchObject({ state: 'draft', text: 'забрать посылку', dueAt: null });
      const interval = input.includes('несколько') ? 'через 1 час 30 минут' : 'через 2 часа';
      const clarify = `уточни напоминание #${draft.id} ${interval}`;
      expect(f.sends.at(-1)?.text).toContain(clarify);
      f.at(f.origin + 5 * minute);
      f.send(clarify);
    }
    await until(() => expect(f.sends.at(-1)?.text).toContain('Напомню вам'));
    expect(f.pending()).toEqual([
      expect.objectContaining({ state: 'pending', dueAt, text: 'забрать посылку' }),
    ]);
    const confirmed = f.sends.at(-1)!.text;
    if (input.includes('завтра'))
      expect(confirmed).toContain('26 ноября 2026 г. в 18:00 (Europe/Moscow)');
    else if (input.startsWith('27.11'))
      expect(confirmed).toContain('27 ноября 2026 г. в 18:00 (Europe/Moscow)');
    else expect(confirmed).toContain(input.includes(' или ') ? '14:00 (UTC)' : '13:30 (UTC)');
    if (input.includes('30 минут') || input.startsWith('27.11')) {
      f.at(input.startsWith('27.11') ? Date.UTC(2026, 10, 25, 15) : f.origin + 60 * minute);
      f.send('Мои напоминания');
      await until(() => expect(f.sends.at(-1)?.text).toContain('#' + f.pending()[0]!.id));
      expect(f.pending()[0]!.state).toBe('pending');
    }
    f.at(dueAt);
    await until(() => expect(f.pending()[0]?.state).toBe('delivered'));
    expect(
      f.sends
        .filter((row) => row.text.startsWith('Напоминание.'))
        .map((row) => [row.peer_id, row.text]),
    ).toEqual([[41, 'Напоминание.\nзабрать посылку']]);
    expect(f.complete).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

test.each([
  {
    request: 'Пенёк, напомни мне через 1 час и 30 забрать посылку',
    destination: peer,
    text: 'забрать посылку',
    clarify: true,
  },
  {
    request: 'Напомни мне через 1 час 30 мин забрать билет',
    destination: 41,
    text: 'забрать билет',
    clarify: false,
  },
  {
    request: 'Напомни мне через 1 час, 30 минут забрать посылку',
    destination: 41,
    text: 'забрать посылку',
    clarify: false,
  },
])('«$request» приводит к одной личной доставке через 90 минут', async (entry) => {
  const f = await remindersFixture(Date.UTC(2026, 10, 25, 12));
  const dueAt = f.origin + 90 * minute;
  const deliveries = () =>
    f.sends.filter(({ text }) => /^Напоминание(?: с опозданием)?\.\n/u.test(text));
  try {
    f.send(entry.request, 41, entry.destination);
    let draftId: number | undefined;
    if (entry.clarify) {
      await until(() => expect(f.sends.at(-1)?.text).toContain('укажите его полностью'));
      expect(f.pending()).toEqual([
        expect.objectContaining({
          chatId: 'vk:41',
          state: 'draft',
          text: entry.text,
          dueAt: null,
        }),
      ]);
      draftId = f.pending()[0]!.id;
      const clarification = `уточни напоминание #${draftId} через 1 час 30 минут`;
      expect(f.sends.at(-1)).toMatchObject({
        peer_id: 41,
        text: expect.stringContaining(clarification),
      });
      expect(f.sends.some(({ text }) => text.startsWith('Напомню вам'))).toBe(false);
      f.at(f.origin + 5 * minute);
      f.send(clarification);
    }

    await until(() => expect(f.sends.at(-1)?.text).toContain('Напомню вам'));
    expect(f.pending()).toEqual([
      expect.objectContaining({ chatId: 'vk:41', state: 'pending', dueAt, text: entry.text }),
    ]);
    const id = f.pending()[0]!.id;
    if (draftId !== undefined) expect(id).toBe(draftId);
    expect(f.sends.filter(({ text }) => text.startsWith('Напомню вам'))).toEqual([
      expect.objectContaining({
        peer_id: 41,
        text: `Напомню вам в этой личке 25 ноября 2026 г. в 13:30 (UTC).\n${entry.text}`,
      }),
    ]);

    f.at(f.origin + 60 * minute);
    f.send('Мои напоминания');
    await until(() => expect(f.sends.at(-1)?.text).toContain(`#${id} · `));
    expect(f.pending()[0]).toMatchObject({ id, state: 'pending', dueAt });
    expect(deliveries()).toEqual([]);

    f.at(dueAt);
    await until(() => expect(f.pending()[0]?.state).toBe('delivered'));
    expect(deliveries()).toEqual([
      expect.objectContaining({
        peer_id: 41,
        date: dueAt / 1_000,
        text: `Напоминание.\n${entry.text}`,
      }),
    ]);
    expect(f.sends.every(({ peer_id }) => peer_id === 41)).toBe(true);
    expect(f.complete).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

test('неполное уточнение сохраняет черновик, а «мин» назначает срок от исходной просьбы', async () => {
  const f = await remindersFixture(Date.UTC(2026, 10, 25, 12));
  const text = 'забрать посылку';
  try {
    f.send(`Напомни мне вечером ${text}`);
    await until(() => expect(f.sends.at(-1)?.text).toContain('укажите точное время'));
    const id = f.pending()[0]!.id;
    const clarify = `Уточни напоминание #${id}`;
    f.at(f.origin + 5 * minute);
    f.send(`${clarify} через 1 час и 30`);
    await until(() =>
      expect(f.sends.at(-1)?.text).toContain(`${clarify.toLowerCase()} через 1 час 30 минут`),
    );
    expect(f.pending()).toEqual([
      expect.objectContaining({ id, state: 'draft', text, dueAt: null }),
    ]);
    expect(f.sends.some(({ text }) => text.startsWith('Напомню вам'))).toBe(false);

    f.at(f.origin + 6 * minute);
    f.send(`${clarify} через 1 час 30 мин`);
    await until(() => expect(f.sends.at(-1)?.text).toContain('13:30 (UTC).\n' + text));
    expect(f.pending()).toEqual([
      expect.objectContaining({ id, state: 'pending', text, dueAt: f.origin + 90 * minute }),
    ]);
    expect(f.sends.every(({ peer_id }) => peer_id === 41)).toBe(true);
    expect(f.complete).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

test.each(['Пенёк,', '[club314|Пенёк],', '[club314|Пенёк]'])(
  'обращение «%s» создаёт одно личное напоминание на событие',
  async (prefix) => {
    const f = await remindersFixture();
    try {
      const event = f.send(prefix + ' напомни мне через 20 минут взять билет', 41, peer);
      await until(() => expect(f.sends.at(-1)?.text).toContain('Напомню вам'));
      f.repeat(event);
      f.send('Мои напоминания');
      await until(() => expect(f.sends.at(-1)?.text).toContain('#' + f.pending()[0]!.id));
      expect(f.pending()).toHaveLength(1);
      expect(f.sends.at(-1)?.text).toContain('взять билет');
      expect(await f.storage.contextMessages.search(f.scope, 'билет', 10, 100)).toEqual([]);
      f.at(f.origin + 20 * minute);
      await until(() => expect(f.pending()[0]?.state).toBe('delivered'));
      expect(f.sends.filter((s) => s.text.startsWith('Напомню вам'))).toHaveLength(1);
      expect(f.sends.filter((s) => s.text === 'Напоминание.\nвзять билет')).toHaveLength(1);
      expect(f.sends.every((s) => s.peer_id === 41)).toBe(true);
      expect(f.complete).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  },
);

test.each(['ответ участнику', 'отдельная реплика'] as const)(
  'выбранное упоминание с формой «%s» доставляет одно напоминание автору',
  async (form) => {
    const f = await remindersFixture();
    try {
      const parent = form === 'ответ участнику' ? f.send('Встреча у входа.', 42, peer) : undefined;
      const requestedAt = f.origin + minute;
      const dueAt = requestedAt + 20 * minute;
      f.at(requestedAt);
      const request = f.send(
        '[club314|Пенёк], напомни мне через 20 минут взять билет',
        41,
        peer,
        requestedAt,
        parent,
      );
      await until(() => expect(f.sends).toHaveLength(1));
      expect({
        peerId: f.sends[0]?.peer_id,
        modelCalls: f.complete.mock.calls.length,
        reminders: f.pending().length,
      }).toEqual({ peerId: 41, modelCalls: 0, reminders: 1 });
      expect(f.sends[0]?.text).toMatch(/^Напомню вам[^\n]*\nвзять билет$/u);
      const item = f.pending()[0]!;
      expect(item).toMatchObject({ chatId: 'vk:41', dueAt, state: 'pending', text: 'взять билет' });

      f.repeat(request);
      const marker = f.send('Проверочная реплика после повтора.', 42, peer);
      const history = () => f.storage.messages.list(f.scope, { limit: 30 });
      await until(async () =>
        expect(
          (await history()).some((row) => row.messageId === String(marker.conversation_message_id)),
        ).toBe(true),
      );
      const recorded = (await history()).filter(
        (row) => row.messageId === String(request.conversation_message_id),
      );
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({ purpose: 'service_notice', userId: 'vk:41' });
      expect(recorded[0]?.replyToMessageId).toBe(
        parent ? String(parent.conversation_message_id) : undefined,
      );
      expect(await f.storage.contextMessages.search(f.scope, 'билет', 10, 100)).toEqual([]);
      expect(f.pending()).toEqual([item]);
      expect(f.sends).toHaveLength(1);

      f.at(dueAt);
      await until(() => expect(f.pending()[0]?.state).toBe('delivered'));
      expect(f.pending()).toEqual([
        expect.objectContaining({ id: item.id, chatId: 'vk:41', dueAt, state: 'delivered' }),
      ]);
      expect(f.sends).toHaveLength(2);
      expect(f.sends[1]).toMatchObject({ peer_id: 41, text: 'Напоминание.\nвзять билет' });
      expect(f.complete).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  },
);

test('ответы участнику с неясной адресацией идут в журнал без отправок, заданий и модели', async () => {
  const f = await remindersFixture();
  try {
    const parent = f.send('Встреча у входа.', 42, peer);
    const hidden = f.send('Реплика недоступна при проверке.', 42, peer);
    f.hideMessage(hidden.conversation_message_id);
    const at = f.origin + minute;
    f.at(at);
    const text = 'напомни мне через 20 минут взять билет';
    const events = [
      f.send('Пенёк, ' + text, 41, peer, at, parent),
      f.send('[club314|Пенёк], [id42|Саша], ' + text, 41, peer, at, parent),
      f.send('[club314|Пенёк], ' + text, 41, peer, at, hidden),
    ];
    const ids = events.map(({ conversation_message_id }) => String(conversation_message_id));
    const recorded = async () =>
      (await f.storage.messages.list(f.scope, { limit: 30 })).filter((row) =>
        ids.includes(row.messageId),
      );
    await until(async () => expect(await recorded()).toHaveLength(3));
    const byId = new Map((await recorded()).map((row) => [row.messageId, row]));
    for (const id of ids.slice(0, 2))
      expect(byId.get(id)?.replyToMessageId).toBe(String(parent.conversation_message_id));
    expect(byId.get(ids[2]!)?.replyToMessageId).toBeUndefined();
    expect(
      f.db
        .prepare(
          'SELECT count(*) FROM queue_jobs q JOIN messages m ON m.id=q.message_id WHERE m.chat_id=? AND m.platform_message_id IN (?,?,?)',
        )
        .pluck()
        .get(f.scope.chatId, ...ids),
    ).toBe(0);
    expect(f.pending()).toEqual([]);
    expect(f.sends).toEqual([]);
    expect(f.complete).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

test('при закрытой личке ответ участнику даёт в беседе подсказку без поручения', async () => {
  const f = await remindersFixture();
  try {
    f.privateAccess(41, false);
    const parent = f.send('Встреча у входа.', 42, peer);
    const at = f.origin + minute;
    f.at(at);
    f.send('[club314|Пенёк], напомни мне через 20 минут взять билет', 41, peer, at, parent);
    await until(() => expect(f.sends).toHaveLength(1));
    expect(f.sends[0]).toMatchObject({
      peer_id: peer,
      text: expect.stringContaining('разрешите сообщения'),
    });
    expect(f.sends[0]?.text).not.toContain('взять билет');
    expect(f.pending()).toEqual([]);
    expect(f.complete).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

test('групповая просьба подтверждается только автору, а UTC-срок переживает указание другого пояса и перезапуск', async () => {
  const f = await remindersFixture();
  try {
    const original = f.send(
      direct + 'Напомни мне взять документы завтра в 18:00 по Москве',
      41,
      peer,
    );
    await until(() => expect(f.sends).toHaveLength(1));
    expect(f.sends[0]).toMatchObject({
      peer_id: 41,
      text: expect.stringContaining('взять документы'),
    });
    expect(f.sends[0]?.text).toContain('Europe/Moscow');
    expect(f.pending()).toEqual([
      expect.objectContaining({ chatId: 'vk:41', dueAt: future, state: 'pending' }),
    ]);
    f.repeat(original);
    f.send(mention, 42, peer);
    await until(() => expect(f.complete).toHaveBeenCalledOnce());
    expect(JSON.stringify(f.complete.mock.calls)).not.toContain('взять документы');
    expect(JSON.stringify(f.logs.mock.calls)).not.toContain('взять документы');
    const history = await f.storage.messages.list(f.scope, { limit: 40 });
    expect(
      history.find(({ messageId }) => messageId === String(original.conversation_message_id)),
    ).toMatchObject({ purpose: 'service_notice' });
    expect(history.some(({ text }) => text.includes('Напомню вам'))).toBe(false);
    await f.storage.chats.update(f.scope, { timezone: 'Asia/Tokyo' });
    await f.halt();
    f.at(future);
    await f.launch();
    expect(f.pending()[0]?.dueAt).toBe(future);
    expect(f.sends.some(({ text }) => text.startsWith('Напоминание.'))).toBe(false);
    await f.resolve('vk:41');
    await until(() => expect(f.pending()[0]).toMatchObject({ state: 'delivered', text: null }));
    const out = f.sends.filter(({ text }) => text.includes('взять документы'));
    expect(out).toHaveLength(2);
    expect(out.every(({ peer_id }) => peer_id === 41)).toBe(true);
    expect(new Set(out.map(({ random_id }) => random_id)).size).toBe(2);
    expect(f.complete).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

test('закрытая личка и чужие просьбы не создают заданий, уточнение и отмена принадлежат автору', async () => {
  const f = await remindersFixture();
  try {
    f.privateAccess(41, false);
    f.send(direct + 'Напомни мне через 20 минут прочитать письмо', 41, peer);
    await until(() =>
      expect(f.sends[0]).toMatchObject({
        peer_id: peer,
        text: expect.stringContaining('разрешите сообщения'),
      }),
    );
    expect(f.sends[0]?.text).not.toContain('прочитать письмо');
    expect(f.pending()).toEqual([]);
    f.privateAccess(41, true);
    f.send('[club315|Другое сообщество], напомни мне через 20 минут взять билет', 41, peer);
    f.send('[club314|Пенёк], напомни мне через 20 минут позвать [id42|Иру]', 41, peer);
    f.send(direct + '«Напомни мне взять паспорт завтра в 18:00»', 41, peer);
    f.send(direct + 'Напомни нам завтра в 18:00', 41, peer);
    f.send('Напомни мне проверить билеты завтра в 18:00');
    await until(() => expect(f.pending()[0]).toMatchObject({ state: 'draft' }));
    const first = f.pending()[0]!.id;
    f.send('Напомни мне посмотреть расписание вечером');
    await until(() => expect(f.pending()).toHaveLength(2));
    const second = f.pending()[1]!.id;
    f.send('Уточни напоминание Europe/Moscow');
    await until(() =>
      expect(f.sends.some(({ text }) => text.includes('Укажите номер черновика'))).toBe(true),
    );
    f.send(`Уточни напоминание #${first} Europe/Moscow`);
    f.send(`Уточни напоминание #${second} завтра в 18:00 Europe/Moscow`);
    await until(() =>
      expect(f.pending().map(({ state }) => state)).toEqual(['pending', 'pending']),
    );
    f.send(`Отмени напоминание ${first}`, 42);
    await until(() =>
      expect(
        f.sends.some(({ peer_id, text }) => peer_id === 42 && text === 'Напоминание не найдено.'),
      ).toBe(true),
    );
    f.send('Мои напоминания', 42);
    await until(() =>
      expect(
        f.sends.some(({ peer_id, text }) => peer_id === 42 && text === 'Напоминаний пока нет.'),
      ).toBe(true),
    );
    f.send(`Отмени напоминание ${first}`);
    await until(() => expect(f.pending()[0]).toMatchObject({ state: 'cancelled', text: null }));
    f.send('Мои напоминания', 41, peer);
    await until(() =>
      expect(
        f.sends.some(
          ({ peer_id, text }) =>
            peer_id === 41 && text.includes('отменено') && text.includes('посмотреть расписание'),
        ),
      ).toBe(false),
    );
    f.send(direct + 'Мои напоминания', 41, peer);
    await until(() =>
      expect(
        f.sends.some(
          ({ peer_id, text }) =>
            peer_id === 41 && text.includes('отменено') && text.includes('посмотреть расписание'),
        ),
      ).toBe(true),
    );
    f.at(future);
    await until(() => expect(f.pending()[1]).toMatchObject({ state: 'delivered', text: null }));
    expect(
      f.sends.filter(({ text }) => text.startsWith('Напоминание.')).map(({ text }) => text),
    ).toEqual(['Напоминание.\nпосмотреть расписание']);
    const completed = f.pending()[1]!.finishedAt!;
    f.at(completed + 7 * 86_400_000 - 1);
    expect(f.pending().some(({ id }) => id === second)).toBe(true);
    f.at(completed + 7 * 86_400_000);
    await until(() => expect(f.pending()).toEqual([]));
    expect(
      f.sends.filter(({ peer_id, text }) => peer_id === 42 && text.includes('проверить билеты')),
    ).toEqual([]);
  } finally {
    await f.close();
  }
});

test.each([0, 1])('возобновление в 18:15:00.00%s соблюдает границу опоздания', async (offset) => {
  const f = await remindersFixture();
  try {
    f.send('Напомни мне взять документы завтра в 18:00 по Москве');
    await until(() => expect(f.sends).toHaveLength(1));
    await f.halt();
    f.at(future + 15 * minute + offset);
    await f.launch();
    await f.resolve('vk:41');
    await until(() =>
      expect(f.pending()[0]).toMatchObject({ state: offset ? 'missed' : 'delivered', text: null }),
    );
    if (offset) {
      expect(f.sends).toHaveLength(1);
      f.send('Мои напоминания');
      await until(() => expect(f.sends[1]?.text).toContain('срок пропущен'));
      expect(f.sends[1]?.text).not.toContain('взять документы');
    } else expect(f.sends[1]?.text).toBe('Напоминание с опозданием.\nвзять документы');
    expect(f.complete).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

test('отмена перед запросом и закрытая личка на сроке не дают отправку', async () => {
  const f = await remindersFixture();
  try {
    f.send('Напомни мне через 20 минут первое дело');
    f.send('Напомни мне через 21 минуту второе дело');
    await until(() => expect(f.sends).toHaveLength(2));
    f.hold();
    f.at(f.origin + 20 * minute);
    await until(() => expect(f.holds).toHaveLength(1));
    f.send(`Отмени напоминание ${f.pending()[0]?.id}`);
    await until(() => expect(f.sends?.[2]?.text).toContain('отменено'));
    f.holds.shift()?.();
    f.privateAccess(41, false);
    f.at(f.origin + 21 * minute);
    await until(() =>
      expect(
        f.attempt.mock.calls.some(
          ([method, args]) =>
            method === 'messages.isMessagesFromGroupAllowed' && args.user_id === 41,
        ),
      ).toBe(true),
    );
    f.at(f.origin + 36 * minute + 1);
    await until(() => expect(f.pending()[1]).toMatchObject({ state: 'missed', text: null }));
    expect(f.sends).toHaveLength(3);
  } finally {
    await f.close();
  }
});

test('потерянный ответ VK блокирует повтор после фактической отправки', async () => {
  const f = await remindersFixture();
  try {
    f.send('Напомни мне через 20 минут взять документы', 41);
    await until(() => expect(f.sends).toHaveLength(1));
    f.lost('Напоминание.');
    f.at(f.origin + 20 * minute);
    await until(() => expect(f.sends).toHaveLength(2));
    await f.halt();
    f.at(f.origin + 25 * minute);
    await f.launch();
    await f.resolve('vk:41');
    f.at(f.origin + 35 * minute + 1);
    await until(() => expect(f.pending()[0]).toMatchObject({ state: 'unknown', text: null }));
    expect(f.sends).toHaveLength(2);
    expect(f.complete).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

test('отдельные части подтверждения и доставки имеют свои ключи, квитанция сверяется без повтора', async () => {
  const f = await remindersFixture();
  const long = 'а'.repeat(2400) + ' конец';
  const chunks = splitVkText('Напоминание.\n' + long);
  try {
    f.send('Напомни мне через 20 минут ' + long);
    await until(() =>
      expect(f.db.prepare('SELECT confirmation FROM personal_reminders').pluck().get()).toBe(
        'delivered',
      ),
    );
    const acknowledgements = f.sends.length;
    expect(acknowledgements).toBeGreaterThan(1);
    f.hide('конец');
    f.at(f.origin + 20 * minute);
    await until(() => expect(f.sends).toHaveLength(acknowledgements + chunks.length));
    await until(() =>
      expect(
        f.db
          .prepare("SELECT state FROM personal_reminder_parts WHERE stage='delivery' ORDER BY part")
          .pluck()
          .all(),
      ).toEqual([...chunks.slice(1).map(() => 'confirmed'), 'unknown']),
    );
    f.reveal();
    await f.halt();
    f.at(f.origin + 21 * minute);
    await f.launch();
    await f.resolve('vk:41');
    await until(() => expect(f.pending()[0]).toMatchObject({ state: 'delivered', text: null }));
    expect(f.sends).toHaveLength(acknowledgements + chunks.length);
    expect(new Set(f.sends.map(({ random_id }) => random_id)).size).toBe(f.sends.length);
    expect(f.sends.every(({ peer_id }) => peer_id === 41)).toBe(true);
    expect(
      f.sends
        .slice(acknowledgements)
        .map(({ text }) => text)
        .join(''),
    ).toBe('Напоминание.\n' + long);
  } finally {
    await f.close();
  }
});

test('смена поколения между захватом и запросом отменяет отправку по старому подключению', async () => {
  const f = await remindersFixture();
  try {
    f.send('Напомни мне через 20 минут взять документы');
    await until(() => expect(f.sends).toHaveLength(1));
    f.hold();
    f.at(f.origin + 20 * minute);
    await until(() => expect(f.holds).toHaveLength(1));
    const original = f.life.current('vk:41');
    const replacement = await f.resolve('vk:41', 'new');
    expect(replacement.generation).not.toBe(original.generation);
    await until(() => expect(f.pending()).toEqual([]));
    f.holds.shift()?.();
    f.send('Мои напоминания');
    await until(() => expect(f.sends[1]?.text).toBe('Напоминаний пока нет.'));
    expect(f.sends).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test('отменённый черновик виден семь суток вместе с назначенным напоминанием', async () => {
  const f = await remindersFixture();
  try {
    f.db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('personal_reminders',11)").run();
    f.send('Напомни мне забрать книгу вечером');
    await until(() => expect(f.pending()[0]?.state).toBe('draft'));
    const id = f.pending()[0]!.id;
    expect(id).toBe(12);
    f.send('Напомни мне через 8 дней взять ключи');
    await until(() => expect(f.pending()[1]?.state).toBe('pending'));
    const due = f.pending()[1]!.dueAt!;
    f.send('Отмени напоминание ' + id);
    await until(() => expect(f.pending()[0]?.state).toBe('cancelled'));
    const cancelled = f.pending()[0]!.finishedAt!;
    async function list() {
      const start = f.sends.length;
      f.send('Мои напоминания');
      await until(() =>
        expect(f.sends.slice(start).some((row) => row.text.includes('взять ключи'))).toBe(true),
      );
      return f.sends.slice(start).find((row) => row.text.includes('взять ключи'))!.text;
    }
    expect(await list()).toContain('#' + id + ' · отменено');
    await f.halt();
    await f.launch();
    await f.resolve('vk:41');
    expect(await list()).toContain('#' + id + ' · отменено');
    f.at(cancelled + 7 * 86400000);
    expect(await list()).not.toContain('отменено');
    f.at(due);
    await until(() =>
      expect(f.sends.filter((row) => row.text === 'Напоминание.\nвзять ключи')).toHaveLength(1),
    );
  } finally {
    await f.close();
  }
});
