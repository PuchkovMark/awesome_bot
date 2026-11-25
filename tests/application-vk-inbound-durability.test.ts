import { expect, test } from 'vitest';
import type { LlmResult } from '../src/llm/types';
import { chatPassportStore } from '../src/storage/chat-passport-store';
import { noticeText } from '../src/storage/notice-types';
import { answer, fixture, peer, until } from './helpers/application-response-fixture';

function journalCount(app: Awaited<ReturnType<typeof fixture>>, destination: number, id: number) {
  return app.db
    .prepare('SELECT count(*) FROM messages WHERE chat_id=? AND platform_message_id=?')
    .pluck()
    .get(`vk:${destination}`, String(id));
}

function holdAuthorCheck(app: Awaited<ReturnType<typeof fixture>>, author: number) {
  return app.holdRequest(
    (method, args) =>
      method === 'messages.getConversationMembers' &&
      args.peer_id === peer &&
      args.member_ids === String(author),
  );
}

test('выключение записывается при задержанной квитанции и останавливает ответ в той же беседе', async () => {
  const app = await fixture();
  const model = Promise.withResolvers<LlmResult>();
  const receipt = app.holdReceipt((text) => text.includes('Режим: нормальный.'));
  try {
    const neighbor = await app.connectGroup(peer + 1);
    app.complete.mockImplementationOnce(() => model.promise);
    const ordinary = app.submit('Пенёк, подскажи про встречу');
    await until(() => expect(app.complete).toHaveBeenCalledOnce());
    app.submit('/настройки', 73);
    await receipt.entered;
    expect(
      app.sends.some((row) => row.peer_id === peer && row.text.includes('Режим: нормальный.')),
    ).toBe(true);

    const off = app.submit('/выключить-бота', 73);
    await app.journaled(off);
    await until(async () => expect((await app.storage.chats.get(app.scope))?.enabled).toBe(false));
    model.resolve(answer);
    await app.interrupted(ordinary);
    const afterOff = app.submit('Пенёк, подскажи ещё кое-что');
    const independent = app.submit('Пенёк, подскажи про поездку', 41, undefined, peer + 1);
    await app.published(independent);
    expect(
      (await app.storage.messages.list(neighbor, { limit: 20 })).some(
        (row) => row.messageId === String(independent),
      ),
    ).toBe(true);
    const history = await app.storage.messages.list(app.scope, { limit: 20 });
    expect(history.find((row) => row.messageId === String(off))?.text).toBe('/выключить-бота');
    expect(history.some((row) => row.messageId === String(afterOff))).toBe(false);
    expect(
      app.sends.filter((row) => row.reply_message?.conversation_message_id === independent),
    ).toEqual([expect.objectContaining({ peer_id: peer + 1, text: answer.text })]);
    expect(app.sends.some((row) => row.peer_id === peer && row.text === answer.text)).toBe(false);
    expect(app.complete).toHaveBeenCalledTimes(2);
  } finally {
    model.resolve(answer);
    receipt.release();
    await app.close();
  }
});

test('два изменения режима применяются последовательно при задержанной квитанции первого', async () => {
  const app = await fixture();
  const receipt = app.holdReceipt((text) => text.includes('Режим: активный.'));
  try {
    const first = app.submit('/режим активный', 73);
    await receipt.entered;
    await app.journaled(first);
    expect((await app.storage.chats.get(app.scope))?.responseMode).toBe('active');
    const second = app.submit('/режим молчаливый', 73);
    await app.journaled(second);
    await until(async () =>
      expect((await app.storage.chats.get(app.scope))?.responseMode).toBe('silent'),
    );
    expect(app.complete).not.toHaveBeenCalled();
  } finally {
    receipt.release();
    await app.close();
  }
});

test('уведомление о переполнении не задерживает локальную команду после записи входа', async () => {
  const app = await fixture();
  const model = Promise.withResolvers<LlmResult>();
  const receipt = app.holdReceipt((text) => text === noticeText);
  try {
    app.complete.mockImplementationOnce(() => model.promise);
    const first = app.submit('Пенёк, подскажи про встречу.');
    await until(() => expect(app.complete).toHaveBeenCalledOnce());
    app.submit('Пенёк, подскажи про поездку.');
    app.submit('Пенёк, подскажи про расписание.');
    const overflow = app.submit('Пенёк, подскажи про концерт.');
    await receipt.entered;
    expect(journalCount(app, peer, overflow)).toBe(1);
    expect(app.sends).toContainEqual(
      expect.objectContaining({
        peer_id: peer,
        text: noticeText,
        reply_message: expect.objectContaining({ conversation_message_id: overflow }),
      }),
    );
    await app.journaled(app.submit('/выключить-бота', 73));
    await until(async () => expect((await app.storage.chats.get(app.scope))?.enabled).toBe(false));
    model.resolve(answer);
    await app.interrupted(first);
    expect(app.complete).toHaveBeenCalledOnce();
  } finally {
    model.resolve(answer);
    receipt.release();
    await app.close();
  }
});

test.each(['confirm', 'revoke', 'reset'] as const)(
  'ответ редактору при задержанной квитанции сохраняется служебно и учитывает %s',
  async (outcome) => {
    const app = await fixture();
    const text = 'Новая редакция правил из ответа на редактор.';
    const receipt = app.holdReceipt((body) =>
      body.includes('Ответьте на это сообщение полным новым текстом.'),
    );
    try {
      await app.storage.authorization.transaction(app.scope, (tx) =>
        tx.grant({ userId: 'vk:41', basis: 'explicit', grantedAt: app.start, grantedBy: 'vk:73' }),
      );
      app.submit('/правила изменить');
      await receipt.entered;
      const parent = app.sends.find((row) =>
        row.text.includes('Ответьте на это сообщение полным новым текстом.'),
      )!;
      const id = app.submit(text, 41, parent);
      await app.journaled(id);
      const row = (await app.storage.messages.list(app.scope, { limit: 20 })).find(
        (item) => item.messageId === String(id),
      );
      expect(row).toMatchObject({ purpose: 'service_notice' });
      expect(row?.text).not.toBe(text);
      const rules = (scope = app.scope) =>
        chatPassportStore(app.storage)
          .read(scope)
          .find(({ section }) => section === 'rules');
      expect(rules()?.text).toBeNull();
      if (outcome === 'confirm') {
        const competing = app.submit('Второй ответ на тот же редактор.', 41, parent);
        await app.journaled(competing);
      }
      await app.journaled(app.submit('Обычная реплика за ответом редактору.'));
      if (outcome === 'revoke')
        await app.storage.authorization.transaction(app.scope, (tx) => tx.remove('vk:41', false));
      const scope = outcome === 'reset' ? await app.connectGroup(peer) : app.scope;
      receipt.release();
      if (outcome === 'confirm') {
        await until(() => expect(rules()?.text).toBe(text));
        app.replay(id, peer);
        await app.journaled(app.submit('Обычная реплика после повтора.'));
        expect(rules()).toMatchObject({ revision: 1, text });
      } else {
        const marker = app.submit('Обычная реплика после закрытия редактора.');
        await until(async () =>
          expect(
            (await app.storage.messages.list(scope, { limit: 20 })).some(
              (item) => item.messageId === String(marker),
            ),
          ).toBe(true),
        );
        expect(rules(scope)?.text).toBeNull();
      }
      expect(app.sends.some((row) => row.peer_id !== peer && row.text.includes(text))).toBe(false);
      expect(app.complete).not.toHaveBeenCalled();
    } finally {
      receipt.release();
      await app.close();
    }
  },
);

test('ранний связанный ответ на показ анкеты остаётся служебным до подтверждения списка', async () => {
  const app = await fixture({ profileNotice: 'Тестовое уведомление о профиле.' });
  const isList = (text: string) => text.startsWith('Ваш ответ увидят участники этой беседы.');
  const receipt = app.holdReceipt(isList);
  try {
    app.at(1000);
    app.submit('/анкета');
    await receipt.entered;
    const parent = app.sends.find((row) => isList(row.text))!;
    const id = app.submit('Ответы автора до проверки показа анкеты.', 41, parent);
    await app.journaled(id);
    expect(
      (await app.storage.messages.list(app.scope, { limit: 20 })).find(
        ({ messageId }) => messageId === String(id),
      ),
    ).toMatchObject({ purpose: 'service_notice', text: 'Действие с анкетой' });
    await until(() =>
      expect(
        app.sends.some(
          (row) =>
            row.peer_id === peer && row.text.startsWith('Доставка вопросов пока не подтверждена.'),
        ),
      ).toBe(true),
    );
    expect(app.complete).not.toHaveBeenCalled();
  } finally {
    receipt.release();
    await app.close();
  }
});

test(
  'штатная остановка завершает два принятых входа до SQLite при задержанной квитанции',
  { timeout: 20_000 },
  async () => {
    const app = await fixture();
    const receipt = app.holdReceipt((text) => text.includes('Режим: нормальный.'));
    const firstRead = holdAuthorCheck(app, 42);
    const secondRead = app.holdRequest(
      (method, args) => method === 'users.get' && args.user_ids === '43',
    );
    try {
      const other = await app.connectGroup(peer + 1);
      const neighbor = app.submit('Сообщение в соседней беседе.', 41, undefined, peer + 1);
      await until(() => expect(journalCount(app, peer + 1, neighbor)).toBe(1));
      app.submit('/настройки', 73);
      await receipt.entered;
      const first = app.submit('Пенёк, подскажи про встречу', 42);
      await firstRead.entered;
      const second = app.submit('Запись, ожидающая обработки предыдущего входа.', 43);
      expect(journalCount(app, peer, first)).toBe(0);
      expect(journalCount(app, peer, second)).toBe(0);
      const sent = app.sends.length;
      const stopped = app.stop();
      const late = app.submit('Событие после закрытия входа.', 44);
      firstRead.release();
      await secondRead.entered;
      expect(journalCount(app, peer, first)).toBe(1);
      expect(journalCount(app, peer, second)).toBe(0);
      secondRead.release();
      expect(await stopped).toBeNull();
      expect(journalCount(app, peer, second)).toBe(1);
      expect(journalCount(app, peer, late)).toBe(0);
      expect(app.complete).not.toHaveBeenCalled();
      expect(app.sends).toHaveLength(sent);

      await app.restart(true, [peer + 1], { retainReceipt: true });
      expect(
        (await app.storage.messages.list(app.scope, { limit: 30 })).find(
          ({ messageId }) => messageId === String(first),
        ),
      ).toMatchObject({ text: 'Пенёк, подскажи про встречу', timestamp: app.start });
      expect(
        (await app.storage.messages.list(other, { limit: 20 })).some(
          ({ messageId }) => messageId === String(neighbor),
        ),
      ).toBe(true);
      app.replay(first, peer);
      app.replay(second, peer);
      await app.journaled(app.submit('Реплика после повтора событий.'));
      expect(journalCount(app, peer, first)).toBe(1);
      expect(journalCount(app, peer, second)).toBe(1);
      expect(journalCount(app, peer + 1, neighbor)).toBe(1);
    } finally {
      firstRead.release();
      secondRead.release();
      receipt.release();
      await app.close();
    }
  },
);

test.each(['stop_failed', 'stop_timeout'] as const)(
  'незавершённый приём имеет результат %s и позднее чтение не добавляет запись',
  async (expected) => {
    const app = await fixture({ stopTimeoutMs: expected === 'stop_timeout' ? 150 : 5000 });
    const input = holdAuthorCheck(app, 42);
    let observed: Awaited<ReturnType<typeof app.stop>> = null;
    try {
      const id = app.submit('Сообщение перед ошибкой остановки.', 42);
      await input.entered;
      if (expected === 'stop_failed') {
        app.db.exec(
          "CREATE TRIGGER reject_input BEFORE INSERT ON messages WHEN NEW.text='Сообщение перед ошибкой остановки.' BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END",
        );
      }
      const stopped = app.stop();
      if (expected === 'stop_failed') input.release();
      observed = await stopped;
      expect(observed).toBe(expected);
      input.release();
      await new Promise((resolve) => setImmediate(resolve));
      expect(journalCount(app, peer, id)).toBe(0);
      expect(app.complete).not.toHaveBeenCalled();
      expect(app.sends).toEqual([]);
    } finally {
      input.release();
      await app.close(observed);
    }
  },
);

test('разрыв наблюдения отзывает принятый вход, который ещё ожидает VK', async () => {
  const app = await fixture();
  const input = holdAuthorCheck(app, 42);
  try {
    const id = app.submit('Пенёк, подскажи про расписание', 42);
    await input.entered;
    await app.loseObservation();
    input.release();
    expect(await app.stop()).toBeNull();
    expect(journalCount(app, peer, id)).toBe(0);
    expect(app.complete).not.toHaveBeenCalled();
  } finally {
    input.release();
    await app.close();
  }
});
