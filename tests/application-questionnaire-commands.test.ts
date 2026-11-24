import { expect, test } from 'vitest';
import { legacyQuestionnaire } from '../src/core/questionnaires/legacy-template';
import { privateQuestionnaire } from '../src/core/questionnaires/private-template';
import { vkMessageLength } from '../src/channels/vk/outbound-text';
import { chat, fixture, peer, until } from './helpers/application-response-fixture';
import { seedBeforeQuestionnaires } from './helpers/questionnaire-upgrade';
import { participantRegistryStore } from '../src/storage/participant-registry';

type App = Awaited<ReturnType<typeof fixture>>;
const profileNotice = 'Тестовое уведомление об анкете и личном профиле.';
const groupHint = 'Ваш ответ увидят участники этой беседы.';
const personalHint = 'Пришлите ответы следующим сообщением.';
const questionList = legacyQuestionnaire.questions.map(({ text }) => text).join('\n');
const personalList = privateQuestionnaire.questions.map(({ text }) => text).join('\n');

function attempt(app: App, destination = peer, user = 41) {
  return app.db
    .prepare(
      `SELECT attempt,presentation,state,shown_at AS shownAt,warning_delivered AS warning
    FROM questionnaire_progress WHERE chat_id=? AND user_id=?`,
    )
    .get(`vk:${destination}`, `vk:${user}`) as
    | {
        attempt: string;
        presentation: string;
        state: string;
        shownAt: number | null;
        warning: number;
      }
    | undefined;
}

function maxLengthQuestions(app: App) {
  const opening = '[id999|Проверочный вопрос]';
  const text =
    opening + 'а'.repeat(Math.floor((vkMessageLength.value - Buffer.byteLength(opening)) / 2));
  const list = Buffer.byteLength(text) === vkMessageLength.value ? text : text + '?';
  app.db
    .prepare(
      'INSERT INTO questionnaire_revisions(chat_id,generation,revision,questions,created_at) VALUES(?,?,2,?,?)',
    )
    .run(app.scope.chatId, app.scope.generation, JSON.stringify([list]), app.start);
  return list;
}

test('команды работают без приглашения и модели, старая отмена безопасна после перезапуска', async () => {
  const app = await fixture({ profileNotice, active: true });
  try {
    app.at(1000);
    const open = app.submit('/анкета');
    await until(() => expect(attempt(app)?.state).toBe('active'));
    const original = attempt(app)!;
    const first = app.sends.find(({ text }) => text.startsWith(groupHint))!;
    expect(first.text.endsWith(questionList)).toBe(true);
    expect(first.disableMentions).toBe(1);
    expect(
      app.db
        .prepare('SELECT purpose,text FROM messages WHERE chat_id=? AND platform_message_id=?')
        .get(chat, String(open)),
    ).toEqual({ purpose: 'service_notice', text: 'Действие с анкетой' });
    expect(
      app.db
        .prepare('SELECT purpose FROM messages WHERE chat_id=? AND platform_message_id=?')
        .pluck()
        .get(chat, String(first.conversation_message_id)),
    ).toBe('service_notice');

    app.at(2000);
    app.replay(open);
    app.submit('/анкета');
    await until(() =>
      expect(app.sends.some(({ text }) => text.startsWith('Анкета открыта.'))).toBe(true),
    );
    expect(attempt(app)).toEqual(original);
    expect(app.sends.filter(({ text }) => text.startsWith(groupHint))).toHaveLength(1);

    app.at(3000);
    app.submit('/Анкета   пауза');
    await until(() => expect(attempt(app)?.state).toBe('paused'));
    app.at(4000);
    app.submit('/анкета');
    await until(() =>
      expect(attempt(app)).toMatchObject({
        state: 'active',
        attempt: original.attempt,
        shownAt: app.start + 4000,
      }),
    );
    expect(attempt(app)?.presentation).not.toBe(original.presentation);
    expect(
      app.sends.filter(({ text }) => text.startsWith(groupHint)).map(({ text }) => text),
    ).toEqual([first.text, first.text]);

    app.at(5000);
    const cancel = app.submit('/анкета отмена');
    await until(() => expect(attempt(app)).toBeUndefined());
    app.at(6000);
    app.submit('/анкета');
    await until(() => expect(attempt(app)?.state).toBe('active'));
    const fresh = attempt(app);
    expect(fresh?.attempt).not.toBe(original.attempt);
    // Даже если журнал команды уже недоступен, её ключ сохранился отдельно.
    app.db
      .prepare('DELETE FROM messages WHERE chat_id=? AND platform_message_id=?')
      .run(chat, String(cancel));
    await app.restart(true);
    app.at(7000);
    app.replay(cancel);
    await app.journaled(cancel);
    app.submit('/анкета');
    await until(() =>
      expect(app.sends.filter(({ text }) => text.startsWith('Анкета открыта.'))).toHaveLength(2),
    );
    expect(attempt(app)).toEqual(fresh);
    expect(app.complete).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

test('первое открытие в личке доставляет уведомление и предлагает повторить команду', async () => {
  const app = await fixture({ profileNotice });
  try {
    app.at(1000);
    app.submit('/анкета', 41, undefined, 41);
    await until(() =>
      expect(app.sends.filter(({ peer_id }) => peer_id === 41).map(({ text }) => text)).toEqual([
        expect.stringContaining(profileNotice),
        expect.stringContaining('повторите /анкета.'),
      ]),
    );
    expect(attempt(app, 41)).toBeUndefined();
    app.at(2000);
    app.submit('/анкета', 41, undefined, 41);
    await until(() => expect(attempt(app, 41)?.state).toBe('active'));
    const shown = app.sends.find(
      ({ peer_id, text }) => peer_id === 41 && text.startsWith(personalHint),
    );
    expect(shown?.text.endsWith(personalList)).toBe(true);
    expect(shown?.disableMentions).toBe(1);
    expect(attempt(app)).toBeUndefined();
    expect(app.complete).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

test('в старой группе без редакции команда предлагает настроить вопросы', async () => {
  const app = await fixture({
    profileNotice,
    existingChat: (path) => seedBeforeQuestionnaires(path, [chat]),
  });
  try {
    app.at(1000);
    app.submit('/анкета');
    await until(() =>
      expect(app.sends.some(({ text }) => text.startsWith('Вопросы не настроены.'))).toBe(true),
    );
    expect(attempt(app)).toBeUndefined();
    expect(app.complete).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

test('полный список в 4000 байт ждёт квитанцию предупреждения, час начинается от квитанции списка', async () => {
  const app = await fixture({ profileNotice, hold: true, active: true });
  const warning = app.holdReceipt((text) => text.startsWith(groupHint));
  try {
    const list = maxLengthQuestions(app);
    expect(Buffer.byteLength(list)).toBe(vkMessageLength.value);
    app.at(1000);
    app.submit('/анкета');
    await until(() => expect(app.holds).toHaveLength(1));
    app.holds[0]!.release();
    await warning.entered;
    expect(app.sends.map(({ text }) => text)).toEqual([expect.stringContaining(groupHint)]);
    expect(attempt(app)).toMatchObject({ state: 'dispatching', shownAt: null, warning: 0 });

    warning.release();
    await until(() => expect(app.holds).toHaveLength(2));
    const confirmation = app.holdReceipt((text) => text === list);
    app.at(10_000);
    app.holds[1]!.release();
    await confirmation.entered;
    expect(app.sends.map(({ text }) => text)).toEqual([expect.stringContaining(groupHint), list]);
    expect(app.sends.map(({ disableMentions }) => disableMentions)).toEqual([1, 1]);
    expect(attempt(app)).toMatchObject({ state: 'dispatching', shownAt: null, warning: 1 });
    app.at(60_000);
    confirmation.release();
    await until(() =>
      expect(attempt(app)).toMatchObject({ state: 'active', shownAt: app.start + 60_000 }),
    );
    expect(app.complete).not.toHaveBeenCalled();
  } finally {
    warning.release();
    await app.close();
  }
});

test.each(['предупреждения', 'списка'] as const)(
  'потеря квитанции %s сохраняет показ при повторе и перезапуске',
  async (lost) => {
    const app = await fixture({ profileNotice, active: true });
    try {
      const list = maxLengthQuestions(app);
      app.at(1000);
      app.failSend((text) =>
        (lost === 'списка' ? text === list : text.startsWith(groupHint))
          ? 'unknownAfterDelivery'
          : undefined,
      );
      const open = app.submit('/анкета');
      await until(() => expect(app.sends).toHaveLength(lost === 'списка' ? 2 : 1));
      const before = attempt(app);
      expect(before).toMatchObject({ state: 'dispatching', shownAt: null });
      await app.restart(true);
      app.failSend(undefined);
      app.at(2000);
      app.replay(open);
      app.submit('/анкета');
      await until(() =>
        expect(
          app.sends.some(({ text }) => text.startsWith('Доставка вопросов пока не подтверждена.')),
        ).toBe(true),
      );
      expect(app.sends.filter(({ text }) => text.startsWith(groupHint))).toHaveLength(1);
      expect(app.sends.filter(({ text }) => text === list)).toHaveLength(lost === 'списка' ? 1 : 0);
      expect(attempt(app)).toEqual(before);
      expect(app.complete).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  },
);

test('после достоверного отказа списка повторная команда отправляет только вопросы', async () => {
  const app = await fixture({ profileNotice });
  try {
    const list = maxLengthQuestions(app);
    app.at(1000);
    app.failSend((text) => (text === list ? 901 : undefined));
    app.submit('/анкета');
    await until(() =>
      expect(attempt(app)).toMatchObject({ state: 'showing', warning: 1, shownAt: null }),
    );
    app.failSend(undefined);
    app.at(2000);
    app.submit('/анкета');
    await until(() =>
      expect(attempt(app)).toMatchObject({ state: 'active', shownAt: app.start + 2000 }),
    );
    expect(app.sends.map(({ text }) => text)).toEqual([expect.stringContaining(groupHint), list]);
  } finally {
    await app.close();
  }
});

test('после смены состава подтверждённый отказ допускает повтор показа в том же поколении', async () => {
  const app = await fixture({ profileNotice, hold: true });
  try {
    app.at(1000);
    app.submit('/анкета');
    await until(() => expect(app.holds).toHaveLength(1));
    const reserved = attempt(app)!;
    app.at(2000);
    app.membership('chat_invite_user_by_link', 42);
    await until(() =>
      expect(participantRegistryStore(app.storage).read(app.scope).participants).toContainEqual(
        expect.objectContaining({ userId: 'vk:42', status: 'present' }),
      ),
    );
    app.holds[0]!.release();
    await until(() =>
      expect(attempt(app)).toMatchObject({
        state: 'showing',
        attempt: reserved.attempt,
        presentation: reserved.presentation,
        shownAt: null,
      }),
    );
    expect(app.sends).toEqual([]);
    app.submit('/анкета');
    await until(() => expect(app.holds).toHaveLength(2));
    app.holds[1]!.release();
    await until(() => expect(attempt(app)?.state).toBe('active'));
    expect(app.sends.filter(({ text }) => text.startsWith(groupHint))).toHaveLength(1);
  } finally {
    await app.close();
  }
});

test.each([peer, 41])('опечатка при заполнении на %d не передаётся модели', async (destination) => {
  const app = await fixture({ profileNotice });
  try {
    const send = (text: string) => app.submit(text, 41, undefined, destination);
    app.at(1000);
    send('/АНКЕТА');
    if (destination === 41) {
      await until(() =>
        expect(app.sends.some((s) => s.text.includes('повторите /АНКЕТА'))).toBe(true),
      );
      app.at(2000);
      send('/анкета');
    }
    await until(() => expect(attempt(app, destination)?.state).toBe('active'));
    send('/анкета паузза');
    await until(() =>
      expect(
        app.sends.some((s) => s.peer_id === destination && s.text.includes('/анкета пауза')),
      ).toBe(true),
    );
    expect(attempt(app, destination)?.state).toBe('active');
    send('/Анкета  пауза');
    await until(() => expect(attempt(app, destination)?.state).toBe('paused'));
    expect(app.complete).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
