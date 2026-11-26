import { expect, test } from 'vitest';
import { legacyQuestionnaire } from '../src/core/questionnaires/legacy-template';
import { chatControlStore } from '../src/storage/chat-control-store';
import { participantRegistryStore } from '../src/storage/participant-registry';
import { questionnaireStore } from '../src/storage/questionnaire-store';
import { chat, fixture, peer, until } from './helpers/application-response-fixture';
import { seedBeforeQuestionnaires } from './helpers/questionnaire-upgrade';

type App = Awaited<ReturnType<typeof fixture>>;
const owner = 73;
const admin = 41;
const member = 42;
const instructions = 'полным списком, по одному вопросу на строку.';
const chunkHint = '\n\nДля правки дождитесь сообщения редактора.';
const saved = 'Анкета сохранена. Количество вопросов — ';
const reopen = 'Откройте /вопросы изменить и ответьте на сообщение редактора полным списком.';
const original = legacyQuestionnaire.questions.map(({ text }) => text);
const current = (app: App) => questionnaireStore(app.storage).current(app.scope);
const questions = (app: App) => current(app)?.questions.map(({ text }) => text);

function opened(app: App, start: number, destination = peer) {
  return app.sends
    .slice(start)
    .find(({ text, peer_id }) => peer_id === destination && text.endsWith(instructions));
}

async function replacementPrompt(app: App, start: number, actor = owner) {
  const find = () =>
    app.sends.slice(start).find((row) => row.text.includes('«Заменить» или «Оставить»'));
  await until(() => expect(find()).toBeDefined());
  const prompt = find()!;
  await until(() =>
    expect(
      questionnaireStore(app.storage).ownsPrompt(
        app.scope,
        String(prompt.conversation_message_id),
        `vk:${actor}`,
      ),
    ).toBe(true),
  );
  return prompt;
}

async function choose(app: App, choice: string, start: number) {
  return app.submit(choice, owner, await replacementPrompt(app, start));
}

async function editor(app: App, actor = owner, destination = peer, reply?: App['sends'][number]) {
  const start = app.sends.length;
  app.submit('/вопросы изменить', actor, reply, destination);
  await until(() => {
    const prompt = opened(app, start, destination);
    expect(prompt).toBeDefined();
    expect(
      app.db
        .prepare('SELECT count(*) FROM questionnaire_editor_prompts WHERE chat_id=? AND receipt=?')
        .pluck()
        .get(`vk:${destination}`, String(prompt?.conversation_message_id)),
    ).toBe(1);
  });
  return opened(app, start, destination)!;
}

test('новая группа сразу получает 16 вопросов, включённое приветствие остаётся самостоятельным', async () => {
  const app = await fixture({ greetings: { members: [owner] } });
  try {
    expect(questions(app)).toEqual(original);
    expect(app.sends).toEqual([]);
    await until(() =>
      expect(participantRegistryStore(app.storage).read(app.scope).lastAttemptComplete).toBe(true),
    );
    const prompt = await editor(app);
    expect(prompt.text).toBe(
      'Вопросы анкеты\n\n' +
        original.join('\n') +
        '\n\nЧтобы изменить анкету, ответьте на это сообщение ' +
        instructions,
    );
    expect(prompt.disableMentions).toBe(1);
    app.submit('/приветствие вкл', owner);
    app.submit('/приглашение вкл', owner);
    await until(() => {
      const controls = chatControlStore(app.storage).read(app.scope);
      expect(controls.greetingEnabledAt).not.toBeNull();
      expect(controls.invitationEnabledAt).not.toBeNull();
    });
    await until(() =>
      expect(
        app.sends.some(({ text }) =>
          text.startsWith('Приглашения к анкете включены. В анкете 16 вопросов.'),
        ),
      ).toBe(true),
    );
    const beforeJoin = app.sends.length;
    app.at(1000);
    app.setMembers([owner, admin]);
    app.membership('chat_invite_user_by_link', admin);
    await until(() =>
      expect(app.db.prepare('SELECT count(*) FROM greeting_windows').pluck().get()).toBe(1),
    );
    app.at(31000);
    await until(() =>
      expect(app.db.prepare('SELECT state,invitation_state FROM greeting_windows').get()).toEqual({
        state: 'delivered',
        invitation_state: 'skipped',
      }),
    );
    expect(app.sends.slice(beforeJoin).map(({ text }) => text)).toEqual([
      'Привет, Тест! Добро пожаловать в беседу!',
    ]);
    expect(app.complete).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

test('подтверждение включения принимает список от своего администратора и сохраняет привязку после повтора', async () => {
  const app = await fixture();
  const invitationHint = 'ответьте на это сообщение всем списком, по одному вопросу на строку.';
  try {
    await app.storage.authorization.transaction(app.scope, (tx) =>
      tx.grant({ userId: 'vk:41', basis: 'explicit', grantedAt: app.start, grantedBy: 'vk:73' }),
    );
    async function enable(count: string) {
      const start = app.sends.length;
      app.submit('/приглашение вкл', admin);
      const reply = () =>
        app.sends
          .slice(start)
          .find(
            ({ peer_id, text }) =>
              peer_id === peer &&
              text.includes('В анкете ' + count) &&
              text.endsWith(invitationHint),
          );
      await until(() => {
        expect(reply()).toBeDefined();
        const receipt = String(reply()!.conversation_message_id);
        expect(questionnaireStore(app.storage).ownsPrompt(app.scope, receipt, 'vk:41')).toBe(true);
      });
      return reply()!;
    }
    const first = await enable('16 вопросов.');
    const beforeHelp = app.sends.length;
    app.submit('/помощь', admin, first);
    await until(() =>
      expect(
        app.sends.slice(beforeHelp).some(({ text }) => text.startsWith('Доступные команды')),
      ).toBe(true),
    );
    await app.journaled(app.submit('Чужая\nПопытка', member, first));
    await app.journaled(app.submit('С пересылкой\nТекст', admin, first, peer, true));
    expect(questions(app)).toEqual(original);
    const two = ['Как к тебе обращаться?', 'Чем увлекаешься?'];
    const event = app.submit(two.join('\n'), admin, first);
    await until(() => expect(questions(app)).toEqual(two));
    const savedVersion = current(app);
    await app.restart(true);
    app.replay(event);
    const second = await enable('2 вопроса.');
    expect(current(app)).toEqual(savedVersion);

    const privateStart = app.sends.length;
    app.submit(
      '/приглашение ' + app.scope.chatId + '@' + app.scope.generation + ' вкл',
      owner,
      undefined,
      owner,
    );
    await until(() =>
      expect(app.sends.slice(privateStart)).toContainEqual(
        expect.objectContaining({
          peer_id: owner,
          text: expect.stringContaining(
            'В анкете 2 вопроса. Чтобы заменить список, отправьте /анкета вопросы изменить в самой беседе.',
          ),
        }),
      ),
    );

    app.submit('/приглашение выкл', owner);
    await until(() =>
      expect(chatControlStore(app.storage).read(app.scope).invitationEnabledAt).toBeNull(),
    );
    const explicitStart = app.sends.length;
    app.submit('/анкета вопросы изменить', owner);
    await until(() => expect(opened(app, explicitStart)).toBeDefined());
    const explicit = opened(app, explicitStart)!;
    await until(() =>
      expect(
        questionnaireStore(app.storage).ownsPrompt(
          app.scope,
          String(explicit.conversation_message_id),
          'vk:73',
        ),
      ).toBe(true),
    );
    app.submit('Следующая редакция?\nВторой вопрос?', owner, explicit);
    await until(() => expect(questions(app)).toEqual(['Следующая редакция?', 'Второй вопрос?']));
    const now = current(app);
    const beforeStale = app.sends.length;
    app.submit('Устаревший\nСписок', admin, second);
    await until(() =>
      expect(
        app.sends
          .slice(beforeStale)
          .some(({ text }) => text.startsWith('Список вопросов изменился.')),
      ).toBe(true),
    );
    const third = await enable('2 вопроса.');
    await app.storage.authorization.transaction(app.scope, (tx) => tx.remove('vk:41', false));
    await app.journaled(app.submit('После отзыва\nСписок', admin, third));
    expect(current(app)).toEqual(now);
    expect(app.complete).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

test('в прежней группе действует стартовая редакция, редактор меняет состав с проверкой прав', async () => {
  const app = await fixture({ existingChat: (path) => seedBeforeQuestionnaires(path, [chat]) });
  try {
    const before = current(app);
    expect(questions(app)).toEqual(original);
    const ownerPrompt = await editor(app);
    expect(ownerPrompt.text).toContain('Вопросы анкеты');
    expect(ownerPrompt.text).toContain('Сколько в ВРН?');
    expect(current(app)).toEqual(before);
    const unauthorized = app.submit('/вопросы', member);
    await app.journaled(unauthorized);
    app.submit('/вопросы', owner, undefined, owner);

    await app.storage.authorization.transaction(app.scope, (tx) =>
      tx.grant({ userId: 'vk:41', basis: 'explicit', grantedAt: app.start, grantedBy: 'vk:73' }),
    );
    const adminPrompt = await editor(app, admin);
    await app.storage.authorization.transaction(app.scope, (tx) => tx.remove('vk:41', false));
    await app.journaled(app.submit('Правка после отзыва', admin, adminPrompt));
    await app.journaled(app.submit('Ответ обычного участника', member, ownerPrompt));
    await app.journaled(app.submit('Ответ на пересылку', owner, ownerPrompt, peer, true));
    expect(current(app)).toEqual(before);
    app.submit(' \n', owner, ownerPrompt);
    await until(() =>
      expect(
        app.sends.some((row) => row.text.startsWith('В списке должен быть хотя бы один вопрос.')),
      ).toBe(true),
    );
    expect(current(app)).toEqual(before);

    const rewritten = [
      original[15]!,
      'Как к тебе обращаться в этой беседе?',
      ...original.slice(2, 15),
      '/выключить-бота — что значит эта команда? [club314|Пенёк]',
    ];
    const ack = saved + rewritten.length + '.';
    const event = app.submit(rewritten.join('\n'), owner, ownerPrompt);
    await until(() => expect(app.sends.some(({ text }) => text === ack)).toBe(true));
    const first = current(app)!;
    expect(questions(app)).toEqual(rewritten);
    expect(first.questions.every(({ skippable }) => skippable)).toBe(true);
    expect(chatControlStore(app.storage).read(app.scope).enabled).toBe(true);
    await app.restart(true);
    app.replay(event);
    const selected = await editor(app);
    expect(selected.text).toContain(rewritten.join('\n'));
    expect(current(app)).toEqual(first);
    const start = app.sends.length;
    app.submit('Новая редакция?', owner, selected);
    await choose(app, 'Заменить', start);
    await until(() => expect(questions(app)).toEqual(['Новая редакция?']));
    expect(questionnaireStore(app.storage).get(app.scope, first.ref)).toEqual(first);
    const neighbor = await app.connectGroup(peer + 1);
    expect(questionnaireStore(app.storage).current(neighbor)?.questions).toEqual(
      legacyQuestionnaire.questions,
    );
    expect(app.sends.some(({ peer_id }) => peer_id === owner)).toBe(false);
    expect(app.complete).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

test('полная копия просмотра сохраняет порядок вопросов при заполнении и точечном изменении', async () => {
  const app = await fixture({ profileNotice: 'Тестовое уведомление об анкете и личном профиле.' });
  try {
    await app.storage.authorization.transaction(app.scope, (tx) =>
      tx.grant({ userId: 'vk:41', basis: 'explicit', grantedAt: app.start, grantedBy: 'vk:73' }),
    );
    app.submit('/вопросы', admin);
    const view = () =>
      app.sends.find(
        ({ peer_id, text }) =>
          peer_id === peer && text.endsWith('Для правки отправьте /вопросы изменить.'),
      );
    await until(() => expect(view()).toBeDefined());
    const copy = view()!.text;
    expect(copy).toBe(
      'Вопросы анкеты\n\n' + original.join('\n') + '\n\nДля правки отправьте /вопросы изменить.',
    );
    const first = await editor(app, admin);
    const from = app.sends.length;
    app.submit(copy, admin, first);
    await until(() =>
      expect(app.sends.slice(from).some(({ text }) => text === saved + '16.')).toBe(true),
    );
    expect(questions(app)).toEqual(original);

    app.at(1000);
    const beforeForm = app.sends.length;
    app.submit('/анкета', member);
    const list = () =>
      app.sends.find(
        ({ peer_id, text }) => peer_id === peer && text.startsWith('Ваш ответ увидят участники'),
      );
    await until(() =>
      expect(
        list(),
        JSON.stringify(app.sends.slice(beforeForm).map(({ text }) => text)),
      ).toBeDefined(),
    );
    expect(list()!.text.split('\n\n').slice(1).join('\n\n').split('\n')).toEqual(original);

    const second = await editor(app, admin);
    const changed = 'Как открыть https://example.org/docs командой /вопросы изменить?';
    const expected = [original[0], changed, ...original.slice(2)];
    const edited = copy.replace('\n' + original[1] + '\n', '\n' + changed + '\n');
    app.submit(edited.replaceAll('\n', '\r\n'), admin, second);
    await until(() => expect(questions(app)).toEqual(expected));
    expect(app.complete).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

test('ответ на просмотр открывает редактор только администратору и сохраняет текущие вопросы до правки', async () => {
  const app = await fixture();
  try {
    await app.storage.authorization.transaction(app.scope, (tx) =>
      tx.grant({ userId: 'vk:41', basis: 'explicit', grantedAt: app.start, grantedBy: 'vk:73' }),
    );
    async function read(command: string) {
      const start = app.sends.length;
      app.submit(command, admin);
      const find = () =>
        app.sends
          .slice(start)
          .find(({ text, peer_id }) => peer_id === peer && text.endsWith(command + ' изменить.'));
      await until(() => expect(find()).toBeDefined());
      return find()!;
    }
    const first = await read('/вопросы');
    const rules = await read('/правила');
    const start = app.sends.length;
    const before = current(app);
    const rejected = [
      app.submit('/вопросы изменить', member, first),
      app.submit('/вопросы изменить', admin, rules),
      app.submit('/вопросы изменить', admin, first, peer, true),
    ];
    for (const id of rejected) await app.journaled(id);
    app.hideVkMessage(first.conversation_message_id);
    await app.journaled(app.submit('/вопросы изменить', admin, first));
    const view = await read('/вопросы');
    expect(opened(app, start)).toBeUndefined();
    const prompt = await editor(app, admin, peer, view);
    expect(current(app)).toEqual(before);
    expect(app.sends.slice(start).filter(({ text }) => text.endsWith(instructions))).toEqual([
      prompt,
    ]);
    expect(app.db.prepare('SELECT count(*) FROM questionnaire_editor_prompts').pluck().get()).toBe(
      1,
    );
    app.submit('Как тебя найти?\nКакие встречи интересны?', admin, prompt);
    await until(() =>
      expect(questions(app)).toEqual(['Как тебя найти?', 'Какие встречи интересны?']),
    );
    expect(app.complete).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

test('длинный список полностью показывается до редактора, частичные и неподтверждённые ответы сохраняют прежнюю редакцию', async () => {
  const app = await fixture();
  try {
    const first = await editor(app);
    const long = 'я'.repeat(1400) + '?\n' + '🙂'.repeat(290) + '?';
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(4000);
    app.submit(long, owner, first);
    await until(() => expect(app.sends.some(({ text }) => text === saved + '2.')).toBe(true));
    const version = current(app)!;

    let from = app.sends.length;
    app.failSend((text) => (text.endsWith(chunkHint) ? 'unknownAfterDelivery' : undefined));
    app.submit('/вопросы изменить', owner);
    await until(() =>
      expect(app.sends.slice(from).some(({ text }) => text.endsWith(chunkHint))).toBe(true),
    );
    const incomplete = app.sends.slice(from).find(({ text }) => text.endsWith(chunkHint))!;
    app.failSend(undefined);
    app.submit('Порция вопросов', owner, incomplete);
    await until(() => expect(app.sends.slice(from).some(({ text }) => text === reopen)).toBe(true));
    expect(opened(app, from)).toBeUndefined();
    expect(current(app)).toEqual(version);

    from = app.sends.length;
    app.failSend((text) =>
      text.startsWith('Редактор анкеты\n') ? 'unknownAfterDelivery' : undefined,
    );
    app.submit('/вопросы изменить', owner);
    await until(() => expect(opened(app, from)).toBeDefined());
    app.failSend(undefined);
    const unknown = opened(app, from)!;
    app.submit('/выключить-бота', owner, unknown);
    await until(() => expect(app.sends.slice(from).some(({ text }) => text === reopen)).toBe(true));
    expect(current(app)).toEqual(version);
    expect(chatControlStore(app.storage).read(app.scope).enabled).toBe(true);

    const beforeView = app.sends.length;
    app.submit('/вопросы', owner);
    const shown = () =>
      app.sends
        .slice(beforeView)
        .filter(({ text }) => text.endsWith('Для правки отправьте /вопросы изменить.'));
    await until(() => expect(shown()).toHaveLength(2));
    expect(shown().every(({ text }) => text.includes('\nСписок показан частями.\n'))).toBe(true);
    from = app.sends.length;
    const final = await editor(app, owner, peer, shown().at(-1)!);
    const chunks = app.sends.slice(from, app.sends.indexOf(final));
    expect(chunks).toHaveLength(2);
    expect(chunks.every(({ text }) => Buffer.byteLength(text) <= 4000)).toBe(true);
    expect(
      chunks.map(({ text }) => text.slice('Вопросы анкеты\n\n'.length, -chunkHint.length)).join(''),
    ).toBe(long);
    const beforePartialView = app.sends.length;
    app.submit(shown()[0]!.text, owner, final);
    await until(() =>
      expect(app.sends.slice(beforePartialView).some(({ text }) => text === reopen)).toBe(true),
    );
    expect(current(app)).toEqual(version);
    const beforePartialEditor = app.sends.length;
    app.submit(chunks[0]!.text, owner, final);
    await until(() =>
      expect(app.sends.slice(beforePartialEditor).some(({ text }) => text === reopen)).toBe(true),
    );
    expect(current(app)).toEqual(version);
    app.submit('🤍'.repeat(1001), owner, final);
    await until(() =>
      expect(app.sends.slice(from).some(({ text }) => text.includes('4000 байт UTF-8'))).toBe(true),
    );
    expect(current(app)).toEqual(version);
    const beforeChoice = app.sends.length;
    app.submit('Новый полный список', owner, final);
    await choose(app, 'Заменить', beforeChoice);
    await until(() => expect(questions(app)).toEqual(['Новый полный список']));
    expect(app.complete).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

test('просмотр оставляет команды командами, явный редактор хранит буквальный ответ', async () => {
  const app = await fixture();
  try {
    for (const command of ['/вопросы', '/правила']) {
      app.submit(command, owner);
      const view = () =>
        app.sends.find((row) =>
          row.text.includes('Для правки отправьте ' + command + ' изменить.'),
        );
      await until(() => expect(view()).toBeDefined());
      for (const [input, prefix] of [
        ['/помощь', 'Доступные команды'],
        ['/анкета показать', 'Анкета'],
      ] as const) {
        const start = app.sends.length;
        app.submit(input, owner, view()!);
        await until(() =>
          expect(app.sends.slice(start).some((row) => row.text.startsWith(prefix))).toBe(true),
        );
      }
    }
    expect(questions(app)).toEqual(original);
    app.submit('/правила изменить', owner);
    const prompt = () => app.sends.find((row) => row.text.includes('полным новым текстом'));
    await until(() => expect(prompt()).toBeDefined());
    app.submit('/анкета показать', owner, prompt()!);
    await until(() =>
      expect(
        app.db
          .prepare("SELECT text FROM chat_passport_sections WHERE section='rules'")
          .pluck()
          .get(),
      ).toBe('/анкета показать'),
    );
    const edit = await editor(app);
    const start = app.sends.length;
    app.submit('Один вопрос?', owner, edit);
    await choose(app, 'Оставить', start);
    await until(() =>
      expect(app.sends.some((row) => row.text === 'Прежний список вопросов сохранён.')).toBe(true),
    );
    expect(questions(app)).toEqual(original);
  } finally {
    await app.close();
  }
});

test('подтверждение сокращения привязано к редакции, действующей роли и доставленному сообщению', async () => {
  const app = await fixture();
  try {
    await app.storage.authorization.transaction(app.scope, (tx) =>
      tx.grant({ userId: 'vk:41', basis: 'explicit', grantedAt: app.start, grantedBy: 'vk:73' }),
    );
    const first = await editor(app);
    app.submit(original.slice(1).join('\n'), owner, first);
    await until(() => expect(questions(app)).toHaveLength(15));
    const next = await editor(app);
    app.submit('Первый?\nВторой?', owner, next);
    await until(() => expect(questions(app)).toHaveLength(2));
    async function propose() {
      const prompt = await editor(app, admin);
      const start = app.sends.length;
      app.submit('Последний?', admin, prompt);
      const question = await replacementPrompt(app, start, admin);
      expect(question.text).toContain('2 вопроса, останется 1');
      return question;
    }
    const stale = await propose();
    const concurrent = await editor(app);
    app.submit('Другой первый?\nДругой второй?', owner, concurrent);
    await until(() => expect(questions(app)?.[0]).toBe('Другой первый?'));
    await app.journaled(app.submit('Заменить', admin, stale));
    expect(questions(app)).toHaveLength(2);
    const offered = await propose();
    await app.storage.authorization.transaction(app.scope, (tx) => tx.remove('vk:41', false));
    await app.journaled(app.submit('Заменить', admin, offered));
    expect(questions(app)).toHaveLength(2);
    const cancelled = await editor(app);
    const beforeCancel = app.sends.length;
    app.submit('Только этот?', owner, cancelled);
    const confirmation = await replacementPrompt(app, beforeCancel);
    await app.restart(true);
    app.submit('Оставить', owner, confirmation);
    await until(() =>
      expect(app.sends.some((row) => row.text === 'Прежний список вопросов сохранён.')).toBe(true),
    );
    expect(questions(app)).toEqual(['Другой первый?', 'Другой второй?']);
    const replacement = await editor(app);
    const start = app.sends.length;
    app.submit('Сохранить один?', owner, replacement);
    await choose(app, 'Заменить', start);
    await until(() => expect(questions(app)).toEqual(['Сохранить один?']));
    const one = await editor(app);
    const event = app.submit('Исправленный?', owner, one);
    await until(() => expect(questions(app)).toEqual(['Исправленный?']));
    const revision = current(app)!.ref.revision;
    app.replay(event);
    await editor(app);
    expect(current(app)!.ref.revision).toBe(revision);
  } finally {
    await app.close();
  }
});
