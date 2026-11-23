import { expect, test } from 'vitest';
import { questionnaireAccessQuestion } from '../src/core/questionnaire/answer';
import { chat, fixture, until } from './helpers/application-response-fixture';

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

async function fill(app: App) {
  app.db
    .prepare(
      'INSERT INTO questionnaire_revisions(chat_id,generation,revision,questions,created_at) VALUES(?,?,2,?,?)',
    )
    .run(chat, app.scope.generation, JSON.stringify([hobby, skipped, hidden]), app.start);
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
    text: '{"1":"Шахматы","2":null,"3":"Личный факт"}',
    usage: { input: 50, output: 30 },
  });
  app.at(1_000);
  app.submit('/анкета');
  await until(() =>
    expect(
      app.db.prepare('SELECT state FROM questionnaire_progress WHERE chat_id=?').pluck().get(chat),
    ).toBe('active'),
  );
  app.at(2_000);
  return app.submit('Пенёк, шахматы? Шахматы. Личный факт.');
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
    expect(state(app)).toMatchObject({ deliveredAt: app.start + 2_000, decision: null });
    expect(values(app)).toEqual([]);
    await app.restart(true);
    app.at(901_999);
    expect(values(app)).toEqual([]);
    const sent = app.sends.length;
    app.at(902_000);
    expect(values(app)).toEqual(['Шахматы', 'Личный факт']);
    expect(app.sends).toHaveLength(sent);
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
