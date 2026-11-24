import { expect, test } from 'vitest';
import { questionnaireAccessQuestion } from '../src/core/questionnaire/answer';
import { questionnairePresentationQuestion } from '../src/core/questionnaire/text';
import {
  answer,
  chat,
  fixture,
  mention,
  peer,
  until,
} from './helpers/application-response-fixture';

type App = Awaited<ReturnType<typeof fixture>>;
const profileNotice = 'Тестовое уведомление об анкете и личном профиле.';
const hobby = 'Чем увлекаетесь?';
const hidden = 'Какой факт скрыть?';
const skipped = 'Что пропустить?';
const explicitOpen = 'Просмотр вашей анкеты открыт для участников этой беседы.';
const explicitClose = 'Просмотр вашей анкеты закрыт.';

function setup(hold = false) {
  return fixture({ profileNotice, active: true, hold, greetings: { members: [41, 42, 73] } });
}

async function fill(app: App, { large = false, held = false } = {}) {
  const secret = large ? 'Длинный ответ ' + 'я'.repeat(1750) : 'Личный факт';
  const privateQuestion = large ? 'Вторая часть ' + 'я'.repeat(500) : hidden;
  app.db
    .prepare(
      'INSERT INTO questionnaire_revisions(chat_id,generation,revision,questions,created_at) VALUES(?,?,2,?,?)',
    )
    .run(chat, app.scope.generation, JSON.stringify([hobby, skipped, privateQuestion]), app.start);
  await until(() =>
    expect(
      app.db
        .prepare("SELECT status FROM chat_participants WHERE chat_id=? AND user_id='vk:41'")
        .pluck()
        .get(chat),
    ).toBe('present'),
  );
  app.complete.mockResolvedValueOnce({
    kind: 'complete',
    text: JSON.stringify({ 1: 'Шахматы', 2: null, 3: secret }),
    usage: { input: 50, output: 30 },
  });
  app.at(1_000);
  app.submit('/анкета');
  if (held) {
    await until(() => expect(app.holds).toHaveLength(1));
    app.holds[0]!.release();
  }
  await until(() =>
    expect(
      app.db.prepare('SELECT state FROM questionnaire_progress WHERE chat_id=?').pluck().get(chat),
    ).toBe('active'),
  );
  app.at(2_000);
  const input = app.submit(`Пенёк, шахматы? Шахматы. ${secret}.`);
  if (held) {
    await until(() => expect(app.holds).toHaveLength(2));
    app.holds[1]!.release();
    await until(() => expect(app.holds).toHaveLength(3));
    app.holds[2]!.release();
    await presentationPrompt(app);
  }
  return input;
}

function state(app: App) {
  return app.db
    .prepare(
      `SELECT prompt_message_id AS receipt,prompt_delivered_at AS deliveredAt,decision,
      decision_message_id AS event FROM questionnaire_access WHERE chat_id=? AND user_id='vk:41'`,
    )
    .get(chat) as
    | {
        receipt: number | null;
        deliveredAt: number | null;
        decision: string | null;
        event: number | null;
      }
    | undefined;
}

function values(app: App) {
  return app.storage.profileFacts.read(app.scope, 'vk:41').facts.map(({ value }) => value);
}

function presentation(app: App) {
  return app.db
    .prepare(
      `SELECT prompt_message_id AS receipt,event_id AS event,state,confirmed_parts AS parts
    FROM questionnaire_presentations WHERE chat_id=? AND user_id='vk:41'`,
    )
    .get(chat) as
    { receipt: number | null; event: number | null; state: string; parts: number } | undefined;
}

async function presentationPrompt(app: App) {
  await until(() => expect(presentation(app)?.receipt).toBeGreaterThan(0));
  const question = app.sends.find(({ text }) => text === questionnairePresentationQuestion)!;
  expect(presentation(app)?.receipt).toBe(question.conversation_message_id);
  return question;
}

function introductions(app: App) {
  return app.sends.filter(
    ({ text }) => text.startsWith('Знакомьтесь,') || text.startsWith('Представление участника'),
  );
}

async function prompt(app: App) {
  await until(() => expect(state(app)?.receipt).toBeGreaterThan(0));
  const question = app.sends.find(({ text }) => text.includes(questionnaireAccessQuestion))!;
  expect(state(app)?.receipt).toBe(question.conversation_message_id);
  return question;
}

test('молчание открывает просмотр ровно через 15 минут от подтверждения доставки, в том числе после перезапуска', async () => {
  const app = await setup();
  try {
    await fill(app);
    await prompt(app);
    await presentationPrompt(app);
    expect(state(app)).toMatchObject({ deliveredAt: app.start + 2_000, decision: null });
    expect(values(app)).toEqual([]);
    await app.restart(true);
    app.at(901_999);
    expect(values(app)).toEqual([]);
    const sent = app.sends.length;
    app.at(902_000);
    expect(values(app)).toEqual(['Шахматы', 'Личный факт']);
    expect(app.sends).toHaveLength(sent);
    expect(introductions(app)).toEqual([]);
    app.at(903_000);
    const close = app.submit('/анкета закрыть');
    await until(() => expect(state(app)).toMatchObject({ decision: 'closed', event: close }));
    expect(values(app)).toEqual([]);
  } finally {
    await app.close();
  }
});

test('ответ автора и команды меняют одну запись доступа, чужой ответ и старое событие пропускаются', async () => {
  const app = await setup();
  try {
    await fill(app);
    const question = await prompt(app);
    app.at(3_000);
    const stranger = app.submit('Разрешить', 42, question);
    await app.journaled(stranger);
    expect(state(app)?.decision).toBeNull();
    expect(values(app)).toEqual([]);
    const open = app.submit('Да', 41, question);
    await until(() => expect(state(app)).toMatchObject({ decision: 'open', event: open }));
    await until(() => expect(app.sends.some(({ text }) => text === explicitOpen)).toBe(true));
    expect(values(app)).toEqual(['Шахматы', 'Личный факт']);
    const close = app.submit('Закрыть', 41, question);
    await until(() => expect(state(app)).toMatchObject({ decision: 'closed', event: close }));
    await until(() => expect(app.sends.some(({ text }) => text === explicitClose)).toBe(true));
    await app.restart(true);
    app.at(902_001);
    app.db
      .prepare('DELETE FROM messages WHERE chat_id=? AND platform_message_id=?')
      .run(chat, String(open));
    app.replay(open);
    await app.journaled(open);
    expect(state(app)).toMatchObject({ decision: 'closed', event: close });
    expect(values(app)).toEqual([]);
    app.at(904_000);
    const reopen = app.submit('/анкета открыть');
    await until(() => expect(state(app)).toMatchObject({ decision: 'open', event: reopen }));
    expect(values(app)).toContain('Шахматы');
    expect(app.complete).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
  }
});

test('неизвестная доставка не открывает доступ даже после 15 минут', async () => {
  const app = await setup();
  try {
    app.failSend((text) =>
      text.includes(questionnaireAccessQuestion) ? 'unknownAfterDelivery' : undefined,
    );
    const input = await fill(app);
    await app.trace(input);
    expect(state(app)).toEqual({ receipt: null, deliveredAt: null, decision: null, event: null });
    app.at(903_000);
    expect(values(app)).toEqual([]);
  } finally {
    await app.close();
  }
});

test('запоздавшая квитанция не меняет явное закрытие автора', async () => {
  const app = await setup();
  const hold = app.holdReceipt((text) => text.includes(questionnaireAccessQuestion));
  try {
    await fill(app);
    await hold.entered;
    expect(values(app)).toEqual([]);
    app.at(3_000);
    const close = app.submit('/анкета закрыть');
    await until(() =>
      expect(state(app)).toMatchObject({ receipt: null, decision: 'closed', event: close }),
    );
    hold.release();
    await prompt(app);
    app.at(904_000);
    expect(values(app)).toEqual([]);
    expect(state(app)).toMatchObject({ decision: 'closed', event: close });
  } finally {
    hold.release();
    await app.close();
  }
});

test('автор может отозвать доступ к анкете в беседе с включённым тихим режимом', async () => {
  const app = await setup();
  try {
    await fill(app);
    await presentationPrompt(app);
    app.at(3_000);
    const open = app.submit('/анкета открыть');
    await until(() => expect(state(app)).toMatchObject({ decision: 'open', event: open }));
    await until(() => expect(app.sends.some(({ text }) => text === explicitOpen)).toBe(true));
    await app.storage.chats.update(app.scope, { responseMode: 'silent' });
    const before = app.sends.length;
    const close = app.submit('/анкета закрыть');
    await until(() => expect(state(app)).toMatchObject({ decision: 'closed', event: close }));
    expect(values(app)).toEqual([]);
    expect(app.sends).toHaveLength(before);
  } finally {
    await app.close();
  }
});

async function requestView(app: App, text: string, user: number, destination = peer) {
  const count = app.sends.length;
  app.submit(text, user, undefined, destination);
  let output = '';
  await until(() => {
    output =
      app.sends
        .slice(count)
        .find(({ peer_id, text }) => peer_id === destination && text.startsWith('Анкета'))?.text ??
      '';
    expect(output).not.toBe('');
  });
  return output;
}

test('беседа и проверенная личка показывают только ответы анкеты, доступные получателю', async () => {
  const app = await setup();
  const stranger = '/анкета показать [id41|Участник]';
  const fromGroup = `/анкета показать ${chat} [id41|Участник]`;
  const expected = `Анкета\n\n${hobby}\nШахматы`;
  try {
    const original = await fill(app);
    const question = await prompt(app);
    expect(await requestView(app, stranger, 42)).toBe('Анкета недоступна.');
    app.at(3_000);
    const spoke = app.submit('Ещё я люблю велосипед.');
    await app.journaled(spoke);
    const messageId = app.db
      .prepare('SELECT id FROM messages WHERE chat_id=? AND platform_message_id=?')
      .pluck()
      .get(chat, String(spoke)) as number;
    await app.storage.authorization.transaction(app.scope, (tx) => {
      expect(
        tx.changeProfileFact('vk:41', {
          subjectId: 'vk:41',
          messageId,
          change: {
            kind: 'set',
            fieldKey: 'transport',
            value: 'велосипед',
            reliability: 'confirmed',
          },
        }),
      ).toBe('recorded');
    });
    app.at(4_000);
    app.submit('/профиль', 41);
    await until(() =>
      expect(
        app.sends.some(({ peer_id, text }) => peer_id === 41 && text.startsWith('Профиль в')),
      ).toBe(true),
    );
    const list = app.sends.find(
      ({ peer_id, text }) => peer_id === 41 && text.startsWith('Профиль в'),
    )!;
    expect(list.text).toContain(hidden);
    app.at(5_000);
    app.submit('/скрыть 2', 41, list, 41);
    await until(() =>
      expect(app.sends.some(({ text }) => text === 'Профиль обновлён.')).toBe(true),
    );
    expect(await requestView(app, `/анкета показать ${chat}`, 41, 41)).toContain('Личный факт');
    const open = app.submit('Разрешить', 41, question);
    await until(() => expect(state(app)).toMatchObject({ decision: 'open', event: open }));
    expect(await requestView(app, stranger, 42)).toBe(expected);
    expect(await requestView(app, stranger, 73)).toBe(expected);
    expect(await requestView(app, '/анкета показать', 41)).toBe(expected);
    expect(await requestView(app, `/анкета показать vk:${peer + 1} @id41`, 41, 41)).toBe(
      'Анкета недоступна.',
    );
    for (const who of [42, 73, 52]) {
      app.submit(fromGroup, who, undefined, who);
      await until(() =>
        expect(
          app.sends.some(
            ({ peer_id, text }) => peer_id === who && text.includes('Чтобы продолжить, повторите'),
          ),
        ).toBe(true),
      );
      expect(await requestView(app, fromGroup, who, who)).toBe(
        who === 52 ? 'Анкета недоступна.' : expected,
      );
    }
    expect(app.complete).toHaveBeenCalledTimes(1);
    expect(
      app.db
        .prepare('SELECT purpose FROM messages WHERE chat_id=? AND platform_message_id=?')
        .pluck()
        .get(chat, String(original)),
    ).toBe('service_notice');

    app.at(6_000);
    app.setMembers([41, 73]);
    app.membership('chat_kick_user', 42, 42);
    await until(() =>
      expect(
        app.db
          .prepare("SELECT status FROM chat_participants WHERE chat_id=? AND user_id='vk:42'")
          .pluck()
          .get(chat),
      ).toBe('left'),
    );
    expect(await requestView(app, fromGroup, 42, 42)).toBe('Анкета недоступна.');
    app.setMembers([73]);
    app.membership('chat_kick_user', 41, 41);
    await until(() => expect(values(app)).toEqual([]));
    expect(await requestView(app, stranger, 73)).toBe('Анкета недоступна.');
  } finally {
    await app.close();
  }
});

test('закрытие анкеты на лимитере блокирует вторую часть ответа в той же беседе', async () => {
  const app = await setup(true);
  try {
    await fill(app, { large: true, held: true });
    const question = await prompt(app);
    app.at(3_000);
    const open = app.submit('Разрешить', 41, question);
    await until(() => expect(state(app)).toMatchObject({ decision: 'open', event: open }));
    app.submit('/анкета показать @id41', 42);
    await until(() => expect(app.holds).toHaveLength(4));
    app.holds[3]!.release();
    await until(() => expect(app.holds).toHaveLength(5));
    expect(
      app.sends.some(({ text }) => text.startsWith('Анкета\n') && text.includes('Шахматы')),
    ).toBe(true);
    const close = app.submit('/анкета закрыть');
    await until(() => expect(state(app)).toMatchObject({ decision: 'closed', event: close }));
    app.holds[4]!.release();
    await app.holds[4]!.finished;
    expect(app.sends.filter(({ text }) => text.includes('Длинный ответ'))).toEqual([]);
  } finally {
    await app.close();
  }
});

test('закрытые ответы скрыты от контекста и инструментов, отзыв доступа защищает готовящийся ответ', async () => {
  const app = await setup();
  const finishing = Promise.withResolvers<void>();
  const useCard = {
    kind: 'tool_calls' as const,
    calls: [
      {
        name: 'participant_card',
        id: 'card',
        arguments: JSON.stringify({ ref: 'current' }),
      },
    ],
    usage: { input: 5, output: 2 },
    text: null,
  };
  try {
    await fill(app);
    await prompt(app);
    app.at(3_000);
    app.complete.mockResolvedValueOnce(useCard).mockResolvedValueOnce(answer);
    await app.published(app.submit(mention));
    const inputs = app.complete.mock.calls
      .slice(1)
      .map(([request]) => JSON.stringify(request.messages));
    expect(inputs).toHaveLength(2);
    expect(inputs.every((text) => !text.includes('Шахматы') && !text.includes('Личный факт'))).toBe(
      true,
    );
    app.at(4_000);
    const opened = app.submit('/анкета открыть');
    await until(() => expect(state(app)).toMatchObject({ event: opened, decision: 'open' }));
    app.complete.mockResolvedValueOnce(useCard).mockImplementationOnce(async (request) => {
      expect(request.messages.find((message) => message.role === 'tool')?.text).toContain(
        'Шахматы',
      );
      await finishing.promise;
      return { ...answer, text: 'Прежняя карточка с шахматами' };
    });
    const event = app.submit(mention);
    await until(() => expect(app.complete).toHaveBeenCalledTimes(5));
    const closed = app.submit('/анкета закрыть');
    await until(() => expect(state(app)).toMatchObject({ event: closed, decision: 'closed' }));
    finishing.resolve();
    await app.trace(event);
    expect(app.sends.some(({ text }) => text === 'Прежняя карточка с шахматами')).toBe(false);
  } finally {
    finishing.resolve();
    await app.close();
  }
});

async function ownProfile(app: App) {
  app.submit('/профиль', 41);
  let list: App['sends'][number] | undefined;
  await until(() => {
    list = app.sends.find(({ peer_id, text }) => peer_id === 41 && text.startsWith('Профиль в'));
    expect(list).toBeDefined();
  });
  return list!;
}

async function hideSecondFact(app: App, list: App['sends'][number]) {
  const before = app.sends.filter(({ text }) => text === 'Профиль обновлён.').length;
  app.submit('/скрыть 2', 41, list, 41);
  await until(() =>
    expect(app.sends.filter(({ text }) => text === 'Профиль обновлён.')).toHaveLength(before + 1),
  );
}

test.each(['команда', 'ответ'] as const)(
  'представление сохраняет отдельное согласие автора через %s и публикуется один раз',
  async (mode) => {
    const app = await setup();
    try {
      await fill(app);
      const viewQuestion = await prompt(app);
      const question = await presentationPrompt(app);
      expect(viewQuestion.conversation_message_id).not.toBe(question.conversation_message_id);
      app.at(3_000);
      for (const event of [
        app.submit('Представить', 42, question),
        app.submit('Да', 41, question),
        app.submit('Представить', 41, viewQuestion),
      ])
        await app.journaled(event);
      expect(presentation(app)).toMatchObject({ state: 'waiting', event: null });
      expect(state(app)?.decision).toBeNull();
      const decline = app.submit('Не представлять', 41, question);
      await until(() =>
        expect(presentation(app)).toMatchObject({ state: 'declined', event: decline }),
      );
      expect(introductions(app)).toEqual([]);
      const list = await ownProfile(app);
      app.at(4_000);
      await hideSecondFact(app, list);
      const consent =
        mode === 'команда'
          ? app.submit('/анкета представить')
          : app.submit('Представить', 41, question);
      await until(() =>
        expect(presentation(app)).toMatchObject({ state: 'delivered', event: consent, parts: 1 }),
      );
      expect(introductions(app)).toHaveLength(1);
      expect(introductions(app)[0]?.text).toContain(hobby + '\nШахматы');
      expect(introductions(app)[0]?.text).not.toMatch(/Личный факт|Что пропустить/u);
      expect(state(app)?.decision).toBeNull();
      expect(values(app)).toEqual([]);
      expect(app.complete).toHaveBeenCalledTimes(1);
      await app.restart(true);
      app.at(5_000);
      app.replay(consent);
      const repeated = app.submit('/анкета представить');
      await app.journaled(repeated);
      expect(presentation(app)).toMatchObject({ state: 'delivered', event: consent, parts: 1 });
      expect(introductions(app)).toHaveLength(1);
    } finally {
      await app.close();
    }
  },
);

test.each(['скрытие поля', 'выход'] as const)(
  'перед отправкой представления учитывается %s автора',
  async (action) => {
    const app = await setup(true);
    try {
      await fill(app, { held: true });
      const list = action === 'скрытие поля' ? await ownProfile(app) : undefined;
      app.at(4_000);
      app.submit('/анкета представить');
      await until(() => expect(app.holds).toHaveLength(4));
      if (list) await hideSecondFact(app, list);
      else {
        app.setMembers([42, 73]);
        app.membership('chat_kick_user', 41, 41);
        await until(() =>
          expect(
            app.db
              .prepare(
                `SELECT returned_at FROM participant_departures
          WHERE chat_id=? AND user_id='vk:41'`,
              )
              .get(chat),
          ).toEqual({ returned_at: null }),
        );
      }
      app.holds[3]!.release();
      await until(() => expect(presentation(app)).toMatchObject({ state: 'failed', parts: 0 }));
      expect(introductions(app)).toEqual([]);
    } finally {
      await app.close();
    }
  },
);

test('неизвестный исход публикации представления блокирует повтор после перезапуска', async () => {
  const app = await setup();
  try {
    await fill(app);
    await presentationPrompt(app);
    app.failSend((text) => (text.startsWith('Знакомьтесь,') ? 'unknownAfterDelivery' : undefined));
    app.at(3_000);
    const event = app.submit('/анкета представить');
    await until(() =>
      expect(presentation(app)).toMatchObject({ state: 'unknown', event, parts: 0 }),
    );
    expect(introductions(app)).toHaveLength(1);
    await app.restart(true);
    app.at(4_000);
    const repeated = app.submit('/анкета представить');
    await app.journaled(repeated);
    expect(presentation(app)).toMatchObject({ state: 'unknown', event, parts: 0 });
    expect(introductions(app)).toHaveLength(1);
  } finally {
    await app.close();
  }
});
