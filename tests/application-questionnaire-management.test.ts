import { expect, test } from 'vitest';
import { fixture, chat, peer, until } from './helpers/application-response-fixture';

type App = Awaited<ReturnType<typeof fixture>>;
async function setup() {
  const app = await fixture({
    profileNotice: 'Уведомление об анкете.',
    active: true,
    greetings: { members: [41, 42, 73] },
  });
  app.setPrivateAllowed(false);
  await until(() =>
    expect(
      app.db
        .prepare("SELECT status FROM chat_participants WHERE chat_id=? AND user_id='vk:41'")
        .pluck()
        .get(chat),
    ).toBe('present'),
  );
  app.db
    .prepare(
      'INSERT INTO questionnaire_revisions(chat_id,generation,revision,questions,created_at) VALUES(?,?,2,?,?)',
    )
    .run(chat, app.scope.generation, JSON.stringify(['Имя?', 'Город?', 'Увлечение?']), app.start);
  return app;
}
async function fill(app: App, start = 1000) {
  app.complete.mockResolvedValueOnce({
    kind: 'complete',
    text: JSON.stringify({ 1: 'Аня', 2: 'Тула', 3: null }),
    usage: { input: 50, output: 30 },
  });
  app.at(start);
  app.submit('/анкета');
  await until(() =>
    expect(
      app.db.prepare('SELECT state FROM questionnaire_progress WHERE chat_id=?').pluck().get(chat),
    ).toBe('active'),
  );
  app.at(start + 1000);
  app.submit('Пенёк, Аня, Тула.');
  await until(() =>
    expect(
      app.db.prepare('SELECT state FROM questionnaire_progress WHERE chat_id=?').pluck().get(chat),
    ).toBe('completed'),
  );
  await until(() => expect(app.sends.at(-1)?.text).toBe('Спасибо! Анкета заполнена.'));
}
async function send(
  app: App,
  text: string,
  contains: string,
  parent?: App['sends'][number],
  from = 41,
) {
  const start = app.sends.length;
  app.submit(text, from, parent);
  await until(() =>
    expect(
      app.sends.slice(start).some((row) => row.peer_id === peer && row.text.includes(contains)),
      `${text} → ${contains}; получено: ${app.sends
        .slice(start)
        .map((row) => row.text)
        .join(' | ')}`,
    ).toBe(true),
  );
  return app.sends.slice(start).find((row) => row.peer_id === peer && row.text.includes(contains))!;
}
test('публичная правка сохраняет нужную позицию прежней редакции и дополняет пропуск после перезапуска', async () => {
  const app = await setup();
  try {
    app.at(1000);
    await send(app, '/анкета изменить', 'Анкета не заполнена');
    await fill(app, 2000);
    app.db
      .prepare(
        'INSERT INTO questionnaire_revisions(chat_id,generation,revision,questions,created_at) VALUES(?,?,3,?,?)',
      )
      .run(chat, app.scope.generation, JSON.stringify(['Новый вопрос?']), app.start);
    const list = await send(app, '/анкета изменить', '2. Город?');
    expect(list.text).toContain('3. Увлечение?');
    expect(list.text).not.toContain('Тула');
    await app.journaled(app.submit('2 Другой', 42, list));
    await app.journaled(app.submit('2 Пересылка', 41, list, peer, true));
    await send(app, '4 Ошибка', 'номером', list);
    await send(app, '2 Казань', '№ 2 сохранён', list);
    await app.restart(true);
    await send(app, '3 Плавание', '№ 3 сохранён', list);
    const card = await send(app, '/анкета показать @id41', 'Плавание', undefined, 42);
    expect(card.text).toContain('Казань');
    expect(card.text).not.toContain('Другой');
    app.at(24 * 3600000 + 3000);
    await send(app, '2 Поздно', 'Срок списка истёк', list);
    expect(app.sends.every((row) => row.peer_id === peer)).toBe(true);
  } finally {
    await app.close();
  }
});

test('удаление подтверждает только автор в беседе, повтор прежнего ответа оставляет новую анкету', async () => {
  const app = await setup();
  try {
    await fill(app);
    let refused = false;
    app.failSend((text) => {
      if (!text.startsWith('Удалить вашу анкету')) return undefined;
      refused = true;
      return 901;
    });
    app.submit('/анкета удалить');
    await until(() => expect(refused).toBe(true));
    expect(
      app.db
        .prepare("SELECT count(*) FROM questionnaire_management_prompts WHERE action='delete'")
        .pluck()
        .get(),
    ).toBe(0);
    app.failSend(undefined);
    const cancel = await send(app, '/анкета удалить', 'В течение 15 минут');
    await app.journaled(app.submit('Удалить', 42, cancel));
    await send(app, 'Оставить', 'Анкета сохранена', cancel);
    await app.journaled(app.submit('Удалить', 41, cancel));
    const expires = await send(app, '/анкета удалить', 'В течение 15 минут');
    app.at(903000);
    await send(app, 'Удалить', 'Срок подтверждения истёк', expires);
    const list = await send(app, '/анкета изменить', '2. Город?');
    await send(app, '2 Казань', '№ 2 сохранён', list);
    const confirm = await send(app, '/анкета удалить', 'В течение 15 минут');
    await app.journaled(app.submit('Удалить', 41, confirm, peer, true));
    await app.restart(true);
    await send(app, 'Удалить', 'Анкета удалена', confirm);
    for (const table of [
      'questionnaire_presentations',
      'questionnaire_progress',
      'questionnaire_answer_facts',
      'profile_facts',
    ])
      expect(
        app.db
          .prepare('SELECT count(*) FROM ' + table + ' WHERE chat_id=?')
          .pluck()
          .get(chat),
      ).toBe(0);
    await send(app, '/анкета показать @id41', 'Анкета не заполнена', undefined, 42);
    await send(app, '/анкета удалить', 'Анкета не заполнена');
    await fill(app, 906000);
    await app.journaled(app.submit('Удалить', 41, confirm));
    await app.journaled(app.submit('2 Старая правка', 41, list));
    expect((await send(app, '/анкета', 'Анкета')).text).toContain('Тула');
    expect(app.sends.every((row) => row.peer_id === peer)).toBe(true);
  } finally {
    await app.close();
  }
});
