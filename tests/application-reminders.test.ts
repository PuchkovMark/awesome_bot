import { splitVkText } from '../src/channels/vk/outbound-text';
import { expect, test } from 'vitest';
import { mention, peer, remindersFixture, until } from './helpers/application-reminders-fixture';

const direct = '[club314|Пенёк] ';
const minute = 60_000;
const future = Date.UTC(2026, 10, 24, 15);

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
