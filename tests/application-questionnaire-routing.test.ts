import { expect, test } from 'vitest';
import type { LlmRequest } from '../src/llm/types';
import { fixture, peer, until } from './helpers/application-response-fixture';
import { questionnaireAccessQuestion } from '../src/core/questionnaire/answer';

type App = Awaited<ReturnType<typeof fixture>>;
const profileNotice = 'Тестовое уведомление об анкете и личном профиле.';
const body = 'Я Аня. Город пропущу. Люблю походы.';
const saved = 'Спасибо! Анкета заполнена.';

function attempt(app: App, destination = peer, user = 41) {
  return app.db
    .prepare(
      `SELECT attempt,presentation,state,template,(SELECT json_group_object(a.position,f.value)
        FROM questionnaire_answer_facts a JOIN profile_facts f ON f.id=a.fact_id
        WHERE a.attempt=q.attempt ORDER BY a.position) AS answers
      FROM questionnaire_progress q WHERE chat_id=? AND user_id=?`,
    )
    .get(`vk:${destination}`, `vk:${user}`) as
    | {
        attempt: string;
        presentation: string;
        state: string;
        template: string;
        answers: string | null;
      }
    | undefined;
}

function extracted(request: LlmRequest) {
  const input = JSON.parse(request.messages[0]!.text!) as {
    answer: string;
    questions: { position: number; text: string }[];
  };
  expect(request.tools).toBeUndefined();
  const name = input.answer.includes('Саша') ? 'Саша' : 'Аня';
  const namePosition = input.questions.length === 3 ? 1 : 2;
  const interestPosition = input.questions.length === 3 ? 3 : 9;
  const answers = Object.fromEntries(
    input.questions.map(({ position }) => [
      position,
      position === namePosition ? name : position === interestPosition ? 'походы' : null,
    ]),
  );
  return {
    kind: 'complete' as const,
    text: JSON.stringify(answers),
    usage: { input: 20, output: 10 },
  };
}

test.each(['Пенёк', 'Пенек', 'упоминание', 'ответ'] as const)(
  'содержание одного ответа завершает анкету при адресации через %s',
  async (address) => {
    const app = await fixture({ profileNotice });
    try {
      app.at(1000);
      app.submit('/анкета');
      await until(() => expect(attempt(app)?.state).toBe('active'));
      const prompt = app.sends.find(({ text }) => text.startsWith('Ваш ответ увидят участники'))!;
      app.complete.mockImplementation(async (request) => {
        const input = JSON.parse(request.messages[0]!.text!);
        expect(input.answer).toContain(body);
        expect(input.questions).toHaveLength(16);
        return extracted(request);
      });
      app.at(2000);
      const input =
        address === 'ответ'
          ? app.submit(body, 41, prompt)
          : app.submit((address === 'упоминание' ? '[club314|Пенёк] ' : address + ', ') + body);
      await app.published(input);
      expect(
        app.sends.some(
          ({ text }) => text.startsWith(saved) && text.includes(questionnaireAccessQuestion),
        ),
      ).toBe(true);
      expect(attempt(app)).toMatchObject({
        state: 'completed',
        answers: '{"2":"Аня","9":"походы"}',
      });
      app.replay(input);
      expect(app.complete).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  },
);

test('обычная реплика, цитата, пересылка и неподтверждённый reply не занимают попытку', async () => {
  const app = await fixture({ profileNotice });
  try {
    app.at(1000);
    const before = app.submit('Пенёк, ' + body);
    await app.journaled(before);
    app.submit('/анкета');
    await until(() => expect(attempt(app)?.state).toBe('active'));
    const original = attempt(app);
    const other = app.submit('Своя реплика другого участника.', 42);
    await app.journaled(other);
    const parent = {
      peer_id: peer,
      conversation_message_id: other,
      from_id: 42,
      text: 'Своя реплика другого участника.',
      date: Math.floor(Date.now() / 1000),
    };
    const absent = { ...parent, from_id: -314 };
    for (const id of [
      app.submit(body),
      app.submit('«Пенёк, ' + body + '»'),
      app.submit('Пенёк, ' + body, 42),
      app.submit('Пенёк, ' + body, 41, parent),
      app.submit('Пенёк, ' + body, 41, absent),
      app.submit('Пенёк, ' + body, 41, undefined, peer, true),
      app.submit('Пенёк отвечает на чужие реплики.'),
    ])
      await app.journaled(id);
    expect(attempt(app)).toEqual(original);
    expect(attempt(app, peer, 42)).toBeUndefined();
    expect(app.db.prepare('SELECT count(*) FROM questionnaire_inputs').pluck().get()).toBe(0);
    expect(app.complete).not.toHaveBeenCalled();
    app.complete.mockImplementation(async (request) => extracted(request));
    app.at(2000);
    await app.published(app.submit('Пенёк, ' + body));
    expect(attempt(app)?.state).toBe('completed');
    expect(app.complete).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
  }
});

test('тёзки заполняют свои анкеты, а команды и ответы разделены между двумя беседами и личкой', async () => {
  const app = await fixture({ profileNotice, active: true });
  const model = Promise.withResolvers<void>();
  const neighbor = peer + 1;
  try {
    await app.connectGroup(neighbor);
    app.name(41, 'Саша', 'Иванов');
    app.name(42, 'Саша', 'Иванов');
    app.at(1000);
    app.submit('/анкета', 41);
    app.submit('/анкета', 42);
    app.submit('/анкета', 41, undefined, neighbor);
    app.submit('/анкета', 41, undefined, 41);
    await until(() =>
      expect([
        attempt(app)?.state,
        attempt(app, peer, 42)?.state,
        attempt(app, neighbor)?.state,
      ]).toEqual(['active', 'active', 'active']),
    );
    await until(() =>
      expect(
        app.sends.some(
          ({ peer_id, text }) => peer_id === 41 && text.includes('повторите /анкета.'),
        ),
      ).toBe(true),
    );
    app.at(2000);
    app.submit('/анкета', 41, undefined, 41);
    await until(() => expect(attempt(app, 41)?.state).toBe('active'));
    const other = attempt(app, neighbor);
    const direct = attempt(app, 41);

    app.complete
      .mockImplementation(async (request) => extracted(request))
      .mockImplementationOnce(async (request) => {
        await model.promise;
        return extracted(request);
      });
    app.at(3000);
    const first = app.submit('Пенёк, ' + body, 41);
    await until(() => expect(attempt(app)?.state).toBe('processing'));
    app.submit('/анкета', 41);
    await until(() =>
      expect(app.sends.some(({ text }) => text === 'Ответ обрабатывается.')).toBe(true),
    );
    expect(app.complete).toHaveBeenCalledTimes(1);
    app.at(4000);
    const second = app.submit('[club314|Пенёк] ' + body.replace('Аня', 'Саша'), 42);
    await until(() => expect(attempt(app, peer, 42)?.state).toBe('processing'));
    expect(app.complete).toHaveBeenCalledTimes(1);
    model.resolve();
    await app.published(first);
    await app.published(second);
    expect(attempt(app)).toMatchObject({ state: 'completed', answers: '{"2":"Аня","9":"походы"}' });
    expect(attempt(app, peer, 42)).toMatchObject({
      state: 'completed',
      answers: '{"2":"Саша","9":"походы"}',
    });
    expect(attempt(app, neighbor)).toEqual(other);
    expect(attempt(app, 41)).toEqual(direct);
    app.submit('/анкета', 42);
    await until(() =>
      expect(app.sends.some(({ text }) => text === 'Вы уже заполнили анкету.')).toBe(true),
    );

    app.at(5000);
    app.submit('/анкета отмена', 41, undefined, neighbor);
    await until(() => expect(attempt(app, neighbor)).toBeUndefined());
    app.submit('/профиль', 41, undefined, 41);
    await until(() =>
      expect(
        app.sends.some(({ peer_id, text }) => peer_id === 41 && text.startsWith('Профиль в ')),
      ).toBe(true),
    );
    expect(attempt(app, 41)).toEqual(direct);
    expect(app.complete).toHaveBeenCalledTimes(2);
    app.at(6000);
    app.submit(body, 41, undefined, 41);
    await until(() =>
      expect(app.sends.some(({ peer_id, text }) => peer_id === 41 && text === saved)).toBe(true),
    );
    expect(attempt(app, 41)).toMatchObject({
      state: 'completed',
      answers: '{"1":"Аня","3":"походы"}',
    });
    expect(attempt(app)?.answers).toBe('{"2":"Аня","9":"походы"}');
    expect(attempt(app, neighbor)).toBeUndefined();
    expect(app.complete).toHaveBeenCalledTimes(3);
  } finally {
    model.resolve();
    await app.close();
  }
});
