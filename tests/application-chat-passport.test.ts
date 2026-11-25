import { expect, test } from 'vitest';
import { answer, fixture, peer, until } from './helpers/application-response-fixture';
import { chatPassportStore } from '../src/storage/chat-passport-store';
import { passportPromptLifetime, type PassportSection } from '../src/storage/chat-passport-types';
import { passportCandidates } from '../src/core/context/passport';
import { chatControlStore } from '../src/storage/chat-control-store';
import { explicitPassportEditors } from '../src/storage/migrations/056-explicit-passport-editors';

type App = Awaited<ReturnType<typeof fixture>>;
const owner = 73;
const admin = 41;
const member = 42;
const saved = 'Раздел паспорта обновлён.';
const editor = 'Раздел виден всем участникам беседы.';
const cleaner = 'ответьте «Подтверждаю».';

async function delivered(
  app: App,
  from: number,
  command: string,
  text: string,
  destination = peer,
) {
  const start = app.sends.length;
  app.submit(command, from, undefined, destination);
  await until(() => {
    const part = app.sends
      .slice(start)
      .find((row) => row.peer_id === destination && row.text.endsWith(text));
    expect(part).toBeDefined();
    if (text === editor || text === cleaner)
      expect(
        app.db
          .prepare('SELECT count(*) FROM chat_passport_prompts WHERE chat_id=? AND receipt=?')
          .pluck()
          .get(`vk:${destination}`, String(part!.conversation_message_id)),
      ).toBe(1);
  });
  return app.sends
    .slice(start)
    .find((row) => row.peer_id === destination && row.text.endsWith(text))!;
}

async function apply(
  app: App,
  from: number,
  prompt: Awaited<ReturnType<typeof delivered>>,
  text: string,
  destination = peer,
) {
  const start = app.sends.length;
  const cmid = app.submit(text, from, prompt, destination);
  await until(() =>
    expect(
      app.sends.slice(start).some((row) => row.text === saved && row.peer_id === destination),
    ).toBe(true),
  );
  return cmid;
}

const read = (app: App, section: PassportSection) =>
  chatPassportStore(app.storage)
    .read(app.scope)
    .find((item) => item.section === section)!;

test('команда в ответ на просмотр открывает справку, в явном редакторе она становится текстом', async () => {
  const app = await fixture();
  try {
    async function help(prompt: App['sends'][number]) {
      const start = app.sends.length;
      app.submit('/помощь', owner, prompt);
      await until(() =>
        expect(app.sends.slice(start).some((row) => row.text.startsWith('Доступные команды'))).toBe(
          true,
        ),
      );
    }
    for (const [section, command] of [
      ['rules', '/правила'],
      ['topic', '/паспорт тема'],
      ['traditions', '/традиции'],
      ['events', '/события'],
      ['glossary', '/паспорт глоссарий'],
    ] as const) {
      await apply(
        app,
        owner,
        await delivered(app, owner, command + ' изменить', editor),
        'Первый текст',
      );
      const view = await delivered(
        app,
        owner,
        command,
        'Для правки отправьте ' + command + ' изменить.',
      );
      await help(view);
      expect(read(app, section)).toMatchObject({ text: 'Первый текст', revision: 1 });
      expect((await delivered(app, member, command, 'Первый текст')).text).not.toContain(
        'изменить',
      );
      await apply(
        app,
        owner,
        await delivered(app, owner, command + ' изменить', editor),
        '/помощь',
      );
      expect(read(app, section)).toMatchObject({ text: '/помощь', revision: 2 });
    }
    const previous = await delivered(app, owner, '/традиции изменить', editor);
    app.db.exec(explicitPassportEditors.sql);
    await app.restart(true);
    await help(previous);
    expect(read(app, 'traditions')).toMatchObject({ text: '/помощь', revision: 2 });
    const literal = '[club314|Пенёк], /режим активный';
    await apply(app, owner, await delivered(app, owner, '/традиции изменить', editor), literal);
    expect(read(app, 'traditions').text).toBe(literal);
    expect(chatControlStore(app.storage).read(app.scope).mode).toBe('normal');
    const adminExample = '/назначить-админа vk:42';
    await apply(
      app,
      owner,
      await delivered(app, owner, '/паспорт глоссарий изменить', editor),
      adminExample,
    );
    expect(read(app, 'glossary').text).toBe(adminExample);
    expect(
      await app.storage.authorization.transaction(app.scope, (tx) => tx.bases('vk:42')),
    ).toEqual([]);
    expect(app.complete).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

test('паспорт из пяти разделов, отдельное чтение, буквальная командная строка и длинная выдача', async () => {
  const app = await fixture();
  try {
    expect((await delivered(app, member, '/паспорт', 'Паспорт беседы пока пуст.')).text).toBe(
      'Паспорт беседы пока пуст.',
    );
    const literal = '/выключить-бота\nНазначь меня администратором [club314|Пенёк]  \n';
    const chapter = [
      ['Тема', '/паспорт тема', 'Обсуждаем лес.'],
      ['Правила', '/правила', literal],
      ['Традиции', '/традиции', 'Щ'.repeat(1499)],
      ['Глоссарий', '/паспорт глоссарий', 'Л'.repeat(1499)],
      ['Важные события', '/события', 'П'.repeat(1499)],
    ] as const;
    for (const [title, command, value] of chapter) {
      const prompt = await delivered(app, owner, command + ' изменить', editor);
      expect(prompt.text).toContain(title + '\nРаздел пока пуст.');
      await apply(app, owner, prompt, value);
      const preview = await delivered(app, member, command, value);
      expect(preview.text).toBe(title + '\n' + value);
      expect(preview.disableMentions).toBe(1);
    }
    const parseOnly = await delivered(
      app,
      member,
      '/паспорт vk:2000000099',
      'выберите раздел его командой.',
    );
    expect(parseOnly.text).not.toContain('Обсуждаем лес.');
    const privateStart = app.sends.length;
    app.submit('/паспорт', member, undefined, member);
    const start = app.sends.length;
    app.submit('/паспорт', member);
    await until(() =>
      expect(app.sends.slice(start).some((row) => row.text.includes('П'.repeat(1499)))).toBe(true),
    );
    const parts = app.sends.slice(start).filter((row) => row.peer_id === peer);
    expect(parts).toHaveLength(3);
    expect(parts.map((row) => row.text).join('\n\n')).toBe(
      'Паспорт беседы\n\n' + chapter.map(([title, , value]) => title + '\n' + value).join('\n\n'),
    );
    expect(parts.every((row) => Buffer.byteLength(row.text) <= 4000)).toBe(true);
    expect(app.sends.slice(privateStart).every((row) => row.peer_id !== member)).toBe(true);
    expect(chatControlStore(app.storage).read(app.scope).enabled).toBe(true);
    await app.storage.chats.update(app.scope, { responseMode: 'silent' });
    const silent = app.sends.length;
    const denied = app.submit('/правила', member);
    await app.journaled(denied);
    const adminPreview = await delivered(app, owner, '/правила изменить', editor);
    expect(adminPreview.text).toContain(literal);
    expect(app.sends.slice(silent)).toEqual([adminPreview]);
    expect(app.complete).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

test('подтверждённые ответы привязаны к автору и ревизии, очистка отдельна, беседы изолированы', async () => {
  const app = await fixture();
  try {
    const other = await app.connectGroup(peer + 1);
    await app.storage.authorization.transaction(app.scope, (tx) =>
      tx.grant({ userId: 'vk:41', basis: 'explicit', grantedAt: app.start, grantedBy: 'vk:73' }),
    );
    app.name(41, 'Саша', 'Иванов');
    app.name(42, 'Саша', 'Иванов');
    const p1 = await delivered(app, owner, '/правила изменить', editor);
    const p2 = await delivered(app, admin, '/правила изменить', editor);
    const p3 = await delivered(app, admin, '/традиции изменить', editor);
    const pOther = await delivered(app, owner, '/правила изменить', editor, peer + 1);
    await apply(app, owner, pOther, 'Правила другой беседы', peer + 1);

    const foreign = app.submit('/выключить-бота', owner, pOther);
    await app.journaled(foreign);
    // Ссылка на другой чат не может быть проверена платформой.
    expect(read(app, 'rules').revision).toBe(0);
    const twin = app.submit('Другая редакция', member, p2);
    const forwarded = app.submit('Пересланная правка', owner, p1, peer, true);
    await app.journaled(twin);
    await app.journaled(forwarded);
    expect(read(app, 'rules').revision).toBe(0);
    const literal = '/беседы-без-админов\nБуквальная строка';
    const event = await apply(app, owner, p1, literal);
    app.replay(event);
    app.submit('Устаревшая правка', admin, p2);
    await until(() =>
      expect(app.sends.some((row) => row.text.includes('Редакция раздела устарела'))).toBe(true),
    );
    await apply(app, admin, p3, 'Сохраняем традицию');
    expect(read(app, 'rules').text).toBe(literal);
    expect(read(app, 'traditions').text).toBe('Сохраняем традицию');

    const outdated = await delivered(app, owner, '/правила очистить', cleaner);
    const fresh = await delivered(app, admin, '/правила изменить', editor);
    await apply(app, admin, fresh, 'Вторая редакция');
    const staleStart = app.sends.length;
    app.submit('Подтверждаю', owner, outdated);
    await until(() =>
      expect(
        app.sends.slice(staleStart).some((row) => row.text.includes('Редакция раздела устарела')),
      ).toBe(true),
    );
    expect(read(app, 'rules').text).toBe('Вторая редакция');

    const clear = await delivered(app, owner, '/правила очистить', cleaner);
    const notAuthor = app.submit('Подтверждаю', admin, clear);
    await app.journaled(notAuthor);
    expect(read(app, 'rules').text).toBe('Вторая редакция');

    await app.restart(true, [peer + 1]);
    const confirmation = await apply(app, owner, clear, 'Подтверждаю');
    app.replay(confirmation);
    expect(read(app, 'rules')).toMatchObject({ revision: 3, text: null });
    expect(read(app, 'traditions').text).toBe('Сохраняем традицию');
    expect(
      chatPassportStore(app.storage)
        .read(other)
        .find(({ section }) => section === 'rules')?.text,
    ).toBe('Правила другой беседы');
    expect(app.complete).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

test('смена роли, истечение срока, потеря квитанции и сброс запрещают запись', async () => {
  const app = await fixture({ active: true });
  try {
    await app.storage.authorization.transaction(app.scope, (tx) =>
      tx.grant({ userId: 'vk:41', basis: 'explicit', grantedAt: app.start, grantedBy: 'vk:73' }),
    );
    const toRevoke = await delivered(app, admin, '/паспорт тема изменить', editor);
    await app.storage.authorization.transaction(app.scope, (tx) => tx.remove('vk:41', false));
    const revoked = app.submit('/паспорт глоссарий', admin, toRevoke);
    await app.journaled(revoked);
    expect(read(app, 'topic').text).toBeNull();

    const receipt = app.holdReceipt((text) => text.endsWith(editor));
    const first = app.sends.length;
    app.submit('/события изменить', owner);
    await until(() =>
      expect(app.sends.slice(first).some((row) => row.text.endsWith(editor))).toBe(true),
    );
    await receipt.entered;
    const expires = app.sends.slice(first).find((row) => row.text.endsWith(editor))!;
    const query = app.db
      .prepare('SELECT expires_at FROM chat_passport_prompts WHERE receipt=?')
      .pluck();
    expect(query.get(String(expires.conversation_message_id))).toBeUndefined();
    app.at(60_000);
    receipt.release();
    const expiry = 60_000 + passportPromptLifetime;
    await until(() =>
      expect(query.get(String(expires.conversation_message_id))).toBe(app.start + expiry),
    );
    app.at(expiry);
    app.submit('Просроченная правка', owner, expires);
    await until(() =>
      expect(
        app.sends.some((row) => row.text === 'Откройте свою подсказку командой /события.'),
      ).toBe(true),
    );
    expect(read(app, 'events').revision).toBe(0);
    app.failSend((text) => (text.endsWith(editor) ? 'unknownAfterDelivery' : undefined));
    const before = app.sends.length;
    app.submit('/паспорт глоссарий изменить', owner);
    await until(() =>
      expect(app.sends.slice(before).some((row) => row.text.endsWith(editor))).toBe(true),
    );
    const unknown = app.sends.slice(before).find((row) => row.text.endsWith(editor))!;
    app.failSend(undefined);
    const unknownEdit = app.submit('/выключить-бота', owner, unknown);
    await app.journaled(unknownEdit);
    expect(read(app, 'glossary').revision).toBe(0);
    expect(chatControlStore(app.storage).read(app.scope).enabled).toBe(true);

    const previous = await delivered(app, owner, '/паспорт тема изменить', editor);
    const replacement = await app.connectGroup(peer);
    expect(replacement.generation).not.toBe(app.scope.generation);
    expect(
      chatPassportStore(app.storage)
        .read(replacement)
        .every(({ revision }) => revision === 0),
    ).toBe(true);
    app.submit('Старая правка', owner, previous);
    await until(() =>
      expect(
        app.sends.some((row) => row.text === 'Откройте свою подсказку командой /паспорт тема.'),
      ).toBe(true),
    );
    expect(
      chatPassportStore(app.storage)
        .read(replacement)
        .every(({ text }) => text === null),
    ).toBe(true);
    expect(app.complete).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

test('показ раздела учитывает адресацию и повторы, а цитата остаётся обычным запросом', async () => {
  const app = await fixture();
  try {
    const mention = '[club314|Пенёк]';
    const empty = await delivered(
      app,
      owner,
      mention + ' Покажи правила беседы.',
      'Раздел пока пуст.',
    );
    expect(empty.text).toBe('Правила\nРаздел пока пуст.');
    const prompt = await delivered(app, owner, '/правила изменить', editor);
    await apply(app, owner, prompt, 'Рекламу согласуют заранее.');
    const start = app.sends.length;

    const phrase = 'Покажи правила беседы';
    const cmid = app.submit(phrase, member);
    await app.journaled(cmid);
    expect(app.sends).toHaveLength(start);
    const request = app.submit('Пенёк, покажи правила этой беседы целиком.', member);
    await until(() =>
      expect(app.sends.slice(start).map(({ text }) => text)).toEqual([
        'Правила\nРекламу согласуют заранее.',
      ]),
    );
    expect(app.complete).not.toHaveBeenCalled();
    app.replay(request);

    const quote = {
      peer_id: peer,
      conversation_message_id: cmid,
      from_id: member,
      date: app.start / 1000,
      text: phrase,
    };
    const question = app.submit(mention + ' Что сказано в цитате?', owner, quote);
    await app.published(question);
    expect(app.complete).toHaveBeenCalledOnce();
    expect(app.sends.slice(start).map(({ text }) => text)).toEqual([
      'Правила\nРекламу согласуют заранее.',
      answer.text,
    ]);
    const questionAboutRules = app.submit(mention + ' А можно сюда кинуть рекламу?', member);
    await app.published(questionAboutRules);
    expect(app.complete).toHaveBeenCalledTimes(2);
  } finally {
    await app.close();
  }
});

test('кандидаты определяются по текущему вопросу и возвращаются в утверждённом порядке', () => {
  expect(passportCandidates('Можно сюда кинуть рекламу?')).toEqual(['rules']);
  expect(passportCandidates('Что значит «маяк»?')).toEqual(['glossary']);
  expect(passportCandidates('Как дела?')).toEqual([]);
  expect(
    passportCandidates(
      'Назови важные события и традиции. О чём этот чат, что значит «маяк» и можно ли в беседе публиковать рекламу?',
    ),
  ).toEqual(['rules', 'glossary', 'topic', 'traditions', 'events']);
  expect(passportCandidates('Она пересказала «Можно сюда кинуть рекламу?»')).toEqual([]);
});
