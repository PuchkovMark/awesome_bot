import { expect, test } from 'vitest';
import { fixture, peer, until } from './helpers/application-response-fixture';

test('помощь и команды совпадают и учитывают права, канал и режим', async () => {
  const app = await fixture({ greetings: { members: [41, 42, 73] } });
  try {
    app.at(1000);
    async function request(text: string, from: number, has: string, destination = peer) {
      const start = app.sends.length;
      app.submit(text, from, undefined, destination);
      await until(() =>
        expect(
          app.sends.slice(start).some((s) => s.peer_id === destination && s.text.includes(has)),
          `${destination} от ${from}, ${text} → ${has}; получено: ${app.sends
            .slice(start)
            .map((row) => row.text)
            .join(' | ')}`,
        ).toBe(true),
      );
      return app.sends.slice(start).find((s) => s.peer_id === destination && s.text.includes(has))!
        .text;
    }
    const member = await request('/помощь', 41, 'Доступные команды');
    expect(await request('/команды', 41, 'Доступные команды')).toBe(member);
    expect(member).toContain('/помощь анкета');
    expect(member).toContain('/помощь напоминания');
    expect(member).toContain('/помощь профиль');
    for (const destination of [peer, 41]) {
      for (const alias of ['/помощь', '/команды']) {
        const profile = await request(alias + ' профиль', 41, '/исправить 2 Казань', destination);
        expect(profile).toContain('ответьте на ту часть личного списка');
        expect(profile).toContain(
          destination === peer ? 'своих фактов из этой беседы' : '/профиль vk:2000000001',
        );
        const suggested = await request(alias + ' профль', 41, 'Доступные темы', destination);
        for (const topic of ['профиль', 'анкета', 'напоминания'])
          expect(suggested).toContain('/помощь ' + topic);
      }
    }
    expect(await request('/помощь анкета', 41, '/анкета удалить')).not.toContain(
      '/вопросы изменить',
    );
    expect(await request('/помощь напоминания', 41, 'Отмени напоминание 12')).toContain(
      'В личке: Мои напоминания',
    );
    expect(member).not.toMatch(
      /\/режим|\/анкета (?:открыть|закрыть|доступ)|Приостановленные беседы/u,
    );
    await request('/анкета показать', 41, 'Анкета');
    await app.storage.authorization.transaction(app.scope, (tx) =>
      tx.grant({ userId: 'vk:42', basis: 'explicit', grantedAt: app.start, grantedBy: 'vk:73' }),
    );
    const admin = await request('/команды', 42, 'Доступные команды');
    expect(admin).toContain('/режим');
    await request('/помощь анкета', 42, '/вопросы изменить');
    await request('/режим', 42, '/режим активный');
    await request('/режим молчаливый', 42, 'молчаливый');
    const quiet = await request('/помощь', 42, 'Доступные команды');
    expect(quiet).toContain('/помощь анкета — вопросы беседы.');
    expect(quiet).not.toMatch(/заполнени|\/помощь профиль/u);
    const settings = await request('/помощь анкета', 42, '/вопросы изменить');
    expect(settings).not.toMatch(/\/анкета|заполнени/u);
    expect(await request('/команды профль', 42, 'Доступные темы')).toBe(
      'Доступные темы\n/помощь анкета — вопросы беседы.',
    );
    await request('/вопросы', 42, 'Для правки отправьте /вопросы изменить.');
    await request('/вопросы изменить', 42, 'ответьте на это сообщение');
    const start = app.sends.length;
    await app.journaled(app.submit('/помощь', 41));
    await request('/настройки', 42, 'молчаливый');
    expect(app.sends.slice(start).filter((x) => x.text.startsWith('Доступные команды'))).toEqual(
      [],
    );
    const owner = await request('/помощь', 73, 'Приостановленные беседы', 73);
    expect(await request('/команды', 73, 'Приостановленные беседы', 73)).toBe(owner);
    await request('Приостановленные беседы', 73, 'бесед', 73);
    expect(app.complete).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

test.each([undefined, 'Уведомление о профиле'])(
  'обе команды открывают свежую личку при уведомлении %s',
  async (notice) => {
    const app = await fixture(notice ? { profileNotice: notice } : {});
    try {
      for (const [command, actor] of [
        ['/помощь', 41],
        ['/команды', 42],
      ] as const) {
        app.submit(command, actor, undefined, actor);
        await until(() =>
          expect(
            app.sends.some(
              (row) => row.peer_id === actor && row.text.startsWith('Доступные команды'),
            ),
          ).toBe(true),
        );
        const texts = app.sends.filter((row) => row.peer_id === actor).map((row) => row.text);
        if (notice) expect(texts[0]).toContain(notice);
        expect(
          app.db
            .prepare('SELECT state FROM chat_connections WHERE chat_id=?')
            .pluck()
            .get('vk:' + actor),
        ).toBe('active');
        app.submit('/помощь напоминания', actor, undefined, actor);
        await until(() =>
          expect(
            app.sends.some(
              (row) => row.peer_id === actor && row.text.includes('Отмени напоминание 12'),
            ),
          ).toBe(true),
        );
      }
    } finally {
      await app.close();
    }
  },
);
test('обращение по имени сохраняет команду и настройки дают рабочие примеры', async () => {
  const app = await fixture();
  try {
    async function response(input: string, prefix: string, actor = 73) {
      const start = app.sends.length;
      app.submit(input, actor);
      const find = () => app.sends.slice(start).find((row) => row.text.startsWith(prefix));
      await until(() => expect(find()).toBeDefined());
      return find()!.text;
    }
    for (const [command, prefix, actor] of [
      ['/правила', 'Правила', 41],
      ['/режим', 'Текущий режим', 73],
      ['/помощь', 'Доступные команды', 41],
    ] as const)
      expect(await response('Пенёк, ' + command, prefix, actor)).toBe(
        await response(command, prefix, actor),
      );
    expect(await response('Пенёк, /анкета показать [id42|Второй]', 'Анкета', 41)).toContain(
      'Анкета',
    );
    expect(
      await response('[club314|Пенёк], /анкета показать [id42|Второй]', 'Анкета', 41),
    ).toContain('Анкета');
    for (const name of ['Пенёк, ', '[club314|Пенёк], ', '[club314|Пенёк] ']) {
      const changed = await response(name + '/режим активный', 'vk:');
      expect(changed).toContain('активный');
      expect(await response('/режим', 'Текущий режим')).toContain('Текущий режим — активный.');
      await response('/режим нормальный', 'vk:');
      await app.journaled(app.submit(name + '/режим активный', 41));
      expect(await response('/режим', 'Текущий режим')).toContain('Текущий режим — нормальный.');
    }
    expect(app.complete).not.toHaveBeenCalled();
    const settings = () =>
      app.db.prepare('SELECT * FROM chat_controls WHERE chat_id=?').get('vk:' + peer);
    const original = settings();
    for (const [input, prefix, example] of [
      ['/приветствие', 'Приветствия', '/приветствие выкл'],
      ['/приглашение', 'Приглашения', '/приглашение вкл'],
      ['/приглашение да', 'Приглашения', '/приглашение выкл'],
      ['/продлить-паузу пять', 'Укажите', '/продлить-паузу 5'],
    ] as const)
      expect(await response(input, prefix)).toContain(example);
    expect(settings()).toEqual(original);
  } finally {
    await app.close();
  }
});
