import { expect, test } from 'vitest';
import { answer, fixture, peer, until } from './helpers/application-response-fixture';

test.each([undefined, 'Уведомление для новой лички'])(
  'первое приветствие записано перед обычным ответом, после него доступна справка, уведомление %s',
  async (profileNotice) => {
    const app = await fixture(profileNotice ? { profileNotice } : {});
    try {
      app.at(1000);
      const receipt = profileNotice
        ? app.holdReceipt((text) => text.includes(profileNotice))
        : null;
      const greeting = app.submit('Привет', 41, undefined, 41);
      app.complete.mockImplementationOnce(async () => {
        expect(
          app.db
            .prepare('SELECT text FROM messages WHERE chat_id=? AND platform_message_id=?')
            .pluck()
            .get('vk:41', String(greeting)),
        ).toBe('Привет');
        return answer;
      });
      if (receipt) {
        await receipt.entered;
        expect(app.complete).not.toHaveBeenCalled();
        app.at(2000);
        receipt.release();
      }
      const replies = () => app.sends.filter((s) => s.peer_id === 41).map((s) => s.text);
      await until(() => expect(replies().at(-1)).toBe(answer.text));
      expect(replies()).toEqual(
        profileNotice ? [expect.stringContaining(profileNotice), answer.text] : [answer.text],
      );
      if (profileNotice)
        expect(
          app.db
            .prepare('SELECT count(*) FROM profile_update_waiting WHERE chat_id=?')
            .pluck()
            .get('vk:41'),
        ).toBe(0);
      for (let count = 1; count <= 2; count++) {
        app.submit('/помощь', 41, undefined, 41);
        await until(() =>
          expect(replies().filter((text) => text.startsWith('Доступные команды'))).toHaveLength(
            count,
          ),
        );
      }
      expect(app.complete).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  },
);

test.each([901, 'unknownAfterDelivery'] as const)(
  'при исходе уведомления %s первое приветствие и анкета ждут подтверждения',
  async (fault) => {
    const profileNotice = 'Уведомление для новой лички';
    const app = await fixture({ profileNotice });
    try {
      app.failSend((text) => (text.includes(profileNotice) ? fault : undefined));
      for (const [actor, text] of [
        [41, 'Привет'],
        [42, '/анкета'],
      ] as const) {
        app.submit(text, actor, undefined, actor);
        await until(() =>
          expect(
            app.db
              .prepare(
                "SELECT state FROM disclosure_publications WHERE chat_id=? AND kind='introduction' AND reason IS NOT NULL",
              )
              .pluck()
              .get('vk:' + actor),
          ).toBe(fault === 901 ? 'pending' : 'unknown'),
        );
        expect(
          app.sends.filter((row) => row.peer_id === actor && !row.text.includes(profileNotice)),
        ).toEqual([]);
        expect(
          app.db
            .prepare('SELECT count(*) FROM questionnaire_progress WHERE chat_id=?')
            .pluck()
            .get('vk:' + actor),
        ).toBe(0);
      }
      expect(app.complete).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  },
);

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
    expect(member).not.toMatch(
      /\/(?:назначить-админа|снять-админа|отозвать-админа|аудит-админа|отменить-отзыв)/u,
    );
    await request('/анкета показать', 41, 'Анкета');
    await app.storage.authorization.transaction(app.scope, (tx) =>
      tx.grant({ userId: 'vk:42', basis: 'explicit', grantedAt: app.start, grantedBy: 'vk:73' }),
    );
    const admin = await request('/команды', 42, 'Доступные команды');
    expect(admin).toContain('/режим');
    expect(admin).toContain('/назначить-админа · /снять-админа — ответом');
    expect(admin).not.toMatch(/\/(?:отозвать-админа|аудит-админа|отменить-отзыв)/u);
    await request('/помощь анкета', 42, '/вопросы изменить');
    await request('/режим', 42, '/режим активный');
    await request('/режим молчаливый', 42, 'молчаливый');
    const quiet = await request('/помощь', 42, 'Доступные команды');
    expect(quiet).toContain('/помощь анкета — вопросы беседы.');
    expect(quiet).not.toMatch(/заполнени|\/помощь профиль/u);
    for (const actor of [42, 73]) {
      for (const alias of ['/помощь', '/команды']) {
        const help = await request(alias, actor, 'Доступные команды');
        const persona = help.match(/^\/персонаж(?=\s)/mu)?.[0];
        expect(persona).toBe('/персонаж');
        const reply = await request(persona!, actor, 'Доступные персонажи');
        expect(reply).toContain('Текущий персонаж');
      }
    }
    const settings = await request('/помощь анкета', 42, '/вопросы изменить');
    expect(settings).not.toMatch(/\/анкета|заполнени/u);
    expect(await request('/команды профль', 42, 'Доступные темы')).toBe(
      'Доступные темы\n/помощь анкета — вопросы беседы.',
    );
    await request('/вопросы', 42, 'Для правки отправьте /вопросы изменить.');
    await request('/вопросы изменить', 42, 'ответьте на это сообщение');
    const start = app.sends.length;
    await app.journaled(app.submit('/помощь', 41));
    await app.journaled(app.submit('/персонаж', 41));
    await request('/настройки', 42, 'молчаливый');
    expect(app.sends.slice(start).some((x) => x.text.includes('Доступные персонажи'))).toBe(false);
    expect(app.sends.slice(start).filter((x) => x.text.startsWith('Доступные команды'))).toEqual(
      [],
    );
    const owner = await request('/помощь', 73, 'Приостановленные беседы', 73);
    expect(owner).toContain('ID беседы и поколение показывает /настройки');
    for (const command of [
      '/назначить-админа',
      '/снять-админа',
      '/отозвать-админа',
      '/аудит-админа',
      '/отменить-отзыв',
    ])
      expect(owner).toContain(`${command} vk:2000000041@7 vk:42`);
    expect(await request('/команды', 73, 'Приостановленные беседы', 73)).toBe(owner);
    await request('Приостановленные беседы', 73, 'бесед', 73);
    expect(app.complete).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

test('участник открывает справку по команде из вступления в новую беседу', async () => {
  const app = await fixture();
  try {
    const destination = peer + 1;
    await app.connectGroup(destination);
    const intro = app.sends.find(
      (s) => s.peer_id === destination && s.text.includes('Пенёк подключён'),
    );
    const command = intro?.text.match(/Список команд — (\/помощь)/u)?.[1];
    expect(command).toBe('/помощь');
    app.submit(command!, 41, undefined, destination);
    await until(() => expect(app.sends.at(-1)?.text).toContain('/помощь напоминания'));
    expect(app.sends.at(-1)?.peer_id).toBe(destination);
    expect(app.sends.at(-1)?.text).not.toContain('/режим');
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
        ['Начать', 43],
        ['/команды напоминания', 44],
      ] as const) {
        app.submit(command, actor, undefined, actor);
        const heading = command.includes('напоминания')
          ? 'Личные напоминания'
          : 'Доступные команды';
        await until(() =>
          expect(
            app.sends.some((row) => row.peer_id === actor && row.text.startsWith(heading)),
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
        if (command === 'Начать') {
          const count = app.sends.length;
          app.submit('/помощь', actor, undefined, actor);
          await until(() => expect(app.sends[count]?.text).toBe(texts.at(-1)));
        }
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

test('приветствие и «Начать» подряд обрабатываются по одному разу при повторной доставке VK', async () => {
  const app = await fixture();
  try {
    const send = (text: string) => app.submit(text, 41, undefined, 41);
    const replies = () => app.sends.filter((s) => s.peer_id === 41).map((s) => s.text);
    const greeting = send('Привет');
    const start = send('Начать');
    await until(() => {
      expect(replies()).toContain(answer.text);
      expect(replies()).toContainEqual(expect.stringContaining('Доступные команды'));
    });
    const help = replies().find((text) => text.startsWith('Доступные команды'))!;
    const generation = app.db
      .prepare("SELECT generation FROM chat_connections WHERE chat_id='vk:41'")
      .pluck();
    const initial = generation.get();
    app.replay(greeting, 41);
    app.replay(start, 41);
    send('/помощь напоминания');
    await until(() => expect(replies().at(-1)).toContain('Личные напоминания'));
    expect(generation.all()).toEqual([initial]);
    expect(replies()).toHaveLength(3);
    expect(replies().filter((s) => s === help)).toHaveLength(1);
    expect(app.complete).toHaveBeenCalledOnce();
    send('/помощь');
    await until(() => expect(replies().at(-1)).toBe(help));
  } finally {
    await app.close();
  }
});

test('«Начать» в цитате, пересылке, упоминании или reply в действующей личке сохраняет обычную маршрутизацию', async () => {
  const app = await fixture();
  try {
    app.submit('/помощь', 41, undefined, 41);
    await until(() => expect(app.sends.at(-1)?.text).toContain('Доступные команды'));
    const parent = app.sends.at(-1)!;
    app.submit('«Начать»', 41, undefined, 41);
    app.submit('Начать', 41, undefined, 41, true);
    app.submit('[club314|Пенёк] Начать', 41, undefined, 41);
    app.submit('Начать', 41, parent, 41);
    app.submit('/помощь напоминания', 41, undefined, 41);
    await until(() =>
      expect(
        app.sends.some((row) => row.peer_id === 41 && row.text.startsWith('Личные напоминания')),
      ).toBe(true),
    );
    expect(app.sends.filter((row) => row.peer_id === 41 && row.text === parent.text)).toHaveLength(
      1,
    );
  } finally {
    await app.close();
  }
});

test('перезапуск сохраняет для участника паузу прежней лички и ранее записанную first_seen', async () => {
  const app = await fixture();
  try {
    const state = app.db.prepare('SELECT state,pause_reason FROM chat_connections WHERE chat_id=?');
    app.submit('Начать', 41, undefined, 41);
    await until(() => expect(app.sends.at(-1)?.peer_id).toBe(41));
    app.submit('Начать', 42, undefined, 42, true);
    await until(() => expect(state.get('vk:42')).toMatchObject({ pause_reason: 'first_seen' }));
    await app.restart();
    const journal = app.db
      .prepare("SELECT id FROM messages WHERE chat_id IN ('vk:41','vk:42') ORDER BY id")
      .pluck();
    const before = journal.all();
    const sent = app.sends.length;
    for (const actor of [41, 42]) {
      app.submit('Начать', actor, undefined, actor);
      app.submit('/помощь', actor, undefined, actor);
    }
    app.submit('/помощь', 43, undefined, 43);
    await until(() => expect(app.sends.some((row) => row.peer_id === 43)).toBe(true));
    expect(state.get('vk:41')).toEqual({ state: 'uncertain', pause_reason: 'startup' });
    expect(state.get('vk:42')).toEqual({ state: 'uncertain', pause_reason: 'first_seen' });
    expect(journal.all()).toEqual(before);
    expect(app.sends.slice(sent).filter((s) => [41, 42].includes(s.peer_id))).toEqual([]);
    expect(app.complete).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

test.each(['/помощь', '/команды', '/помощь напоминания', '/команды напоминания'])(
  'первое сообщение владельца «%s» открывает личную справку',
  async (command) => {
    const app = await fixture();
    try {
      app.submit(command, 73, undefined, 73);
      await until(() => expect(app.sends.at(-1)?.peer_id).toBe(73));
      const text = app.sends.at(-1)!.text;
      if (command.includes('напоминания')) {
        for (const example of [
          'Напомни мне',
          'Мои напоминания',
          'Отмени напоминание',
          'Создать ещё одно #12',
          'команду проверки или повтора',
        ])
          expect(text).toContain(example);
      } else {
        expect(text).toContain('/помощь напоминания');
        expect(text).toContain('Приостановленные беседы');
      }
      expect(app.complete).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  },
);

test('пересылка и последующее «Начать» в приостановленной личке сохраняют паузу', async () => {
  const app = await fixture();
  try {
    const state = () =>
      app.db.prepare("SELECT state FROM chat_connections WHERE chat_id='vk:41'").pluck().get();
    app.submit('Начать', 41, undefined, 41, true);
    await until(() => expect(state()).toBe('uncertain'));
    app.submit('Начать', 41, undefined, 41);
    app.submit('/помощь', 42, undefined, 42);
    await until(() => expect(app.sends.some((row) => row.peer_id === 42)).toBe(true));
    expect(state()).toBe('uncertain');
    expect(app.sends.filter((row) => row.peer_id === 41)).toEqual([]);
  } finally {
    await app.close();
  }
});

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
