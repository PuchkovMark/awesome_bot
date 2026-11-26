import { expect, test } from 'vitest';
import { privateQuestionnaireViewHint } from '../src/core/questionnaire/text';
import { seedLegacyQuestionnaireRestriction } from './helpers/questionnaire-upgrade';
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

function setup(hold = false) {
  return fixture({ profileNotice, active: true, hold, greetings: { members: [41, 42, 43, 73] } });
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
    await completion(app);
  }
  return input;
}

function values(app: App) {
  return app.storage.profileFacts.read(app.scope, 'vk:41').facts.map(({ value }) => value);
}

function introductions(app: App) {
  return app.sends.filter(
    ({ text }) => text.startsWith('Знакомьтесь,') || text.startsWith('Представление участника'),
  );
}

async function completion(app: App) {
  await until(() =>
    expect(app.sends.some((row) => row.text.startsWith('Спасибо! Анкета заполнена.'))).toBe(true),
  );
  return app.sends.find((row) => row.text.startsWith('Спасибо! Анкета заполнена.'))!;
}

test('публичные ответы доступны сразу и после перезапуска, прежние команды доступа ничего не меняют', async () => {
  const app = await setup();
  try {
    await until(() =>
      expect(
        app.db.prepare("SELECT status FROM chat_participants WHERE user_id='vk:41'").pluck().get(),
      ).toBe('present'),
    );
    app.at(500);
    expect(await requestView(app, '/анкета показать @id41', 42)).toBe('Анкета не заполнена');
    const sent = app.sends.length;
    await fill(app);
    await completion(app);
    expect(values(app)).toEqual(['Шахматы', 'Личный факт']);
    expect(app.sends.slice(sent).map(({ text }) => text)).toEqual([
      expect.stringContaining('Ваш ответ увидят участники этой беседы.'),
      'Спасибо! Анкета заполнена.',
    ]);
    const previous = await completion(app);
    app.db
      .prepare('UPDATE questionnaire_progress SET legacy_access_prompt_id=? WHERE chat_id=?')
      .run(previous.conversation_message_id, chat);
    await app.journaled(app.submit('Закрыть', 41, previous));
    await app.journaled(app.submit('/анкета закрыть'));
    expect(await requestView(app, '/анкета показать @id41', 42)).toContain('Шахматы');
    await app.restart(true);
    expect(values(app)).toEqual(['Шахматы', 'Личный факт']);
    expect(introductions(app)).toEqual([]);
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
  const stranger = '/анкета [id41|Тёзка]';
  const fromGroup = `/анкета показать ${chat} [id41|Участник]`;
  const initial = `Анкета

${hobby}
Шахматы`;
  const edited = `${initial}

${hidden}
Новый ответ`;
  try {
    app.name(41, 'Саша', 'Иванов');
    app.name(42, 'Саша', 'Иванов');
    const original = await fill(app);
    await completion(app);
    expect(await requestView(app, stranger, 42)).toContain('Шахматы');
    expect(await requestView(app, '/анкета [id42|Тёзка]', 43)).toBe('Анкета не заполнена');
    expect(await requestView(app, '/анкета показать [id41|Тёзка]', 43)).toContain('Шахматы');
    app.at(3_000);
    const list = await ownProfile(app);
    expect(list.text).toContain('/анкета изменить');
    expect(list.text).not.toContain('/скрыть');
    app.db
      .prepare("UPDATE profile_command_positions SET visibility='unknown' WHERE position=2")
      .run();
    for (const command of ['/скрыть 2', '/исправить 2 Закрытый текст']) {
      const before = app.sends.length;
      app.submit(command, 41, list, 41);
      await until(() =>
        expect(app.sends.slice(before)).toContainEqual(
          expect.objectContaining({
            peer_id: 41,
            text: 'Чтобы исправить ответ анкеты, отправьте /анкета изменить в беседе.',
          }),
        ),
      );
      expect(values(app)).toEqual(['Шахматы', 'Личный факт']);
    }

    app.at(5_000);
    seedLegacyQuestionnaireRestriction(app.db, app.scope, 'vk:41', 3, app.start + 4_000);
    expect(await requestView(app, `/анкета показать ${chat}`, 41, 41)).toBe(initial);
    expect(await requestView(app, stranger, 42)).toBe(initial);
    app.submit('/анкета изменить');
    await until(() =>
      expect(app.sends.some((row) => row.text.includes('3. ' + hidden))).toBe(true),
    );
    const edit = app.sends.find((row) => row.text.includes('3. ' + hidden))!;
    app.submit('3 Новый ответ', 41, edit);
    await until(() =>
      expect(app.sends.some((row) => row.text.includes('№ 3 сохранён'))).toBe(true),
    );
    expect(await requestView(app, `/анкета показать ${chat}`, 41, 41)).toBe(edited);
    expect(await requestView(app, stranger, 42)).toBe(edited);
    expect(await requestView(app, stranger, 43)).toBe(edited);
    app.submit('/анкета показать', 41, undefined, 41);
    await until(() => expect(app.sends.at(-1)?.text).toBe(privateQuestionnaireViewHint));
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
        who === 52 ? 'Анкета недоступна.' : edited,
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

test('выход автора во время выдачи блокирует вторую часть ответа в той же беседе', async () => {
  const app = await setup(true);
  try {
    await fill(app, { large: true, held: true });
    await completion(app);
    app.at(3_000);
    app.submit('/анкета показать @id41', 42);
    await until(() => expect(app.holds).toHaveLength(3));
    app.holds[2]!.release();
    await until(() => expect(app.holds).toHaveLength(4));
    expect(
      app.sends.some(({ text }) => text.startsWith('Анкета\n') && text.includes('Шахматы')),
    ).toBe(true);
    app.setMembers([42, 73]);
    app.membership('chat_kick_user', 41, 41);
    await until(() => expect(values(app)).toEqual([]));
    app.holds[3]!.release();
    await app.holds[3]!.finished;
    expect(app.sends.filter(({ text }) => text.includes('Длинный ответ'))).toEqual([]);
  } finally {
    await app.close();
  }
});

test('изменение публичного ответа защищает устаревшую карточку в готовящемся ответе модели', async () => {
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
    await completion(app);
    app.at(4_000);
    app.complete.mockResolvedValueOnce(useCard).mockImplementationOnce(async (request) => {
      expect(request.messages.find((message) => message.role === 'tool')?.text).toContain(
        'Шахматы',
      );
      await finishing.promise;
      return { ...answer, text: 'Прежняя карточка с шахматами' };
    });
    const event = app.submit(mention);
    await until(() => expect(app.complete).toHaveBeenCalledTimes(3));
    app.submit('/анкета изменить');
    await until(() =>
      expect(app.sends.some(({ text }) => text.includes('3. ' + hidden))).toBe(true),
    );
    app.submit(
      '1 Шашки',
      41,
      app.sends.find(({ text }) => text.includes('3. ' + hidden))!,
    );
    await until(() =>
      expect(app.sends.some(({ text }) => text.includes('№ 1 сохранён'))).toBe(true),
    );
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

test('старые команда и квитанция о представлении не отправляют ответ и не заполняют новую анкету', async () => {
  const app = await setup();
  try {
    await fill(app);
    const old = await completion(app);
    app.db
      .prepare(
        `INSERT INTO questionnaire_presentations(chat_id,generation,user_id,attempt,prompt_message_id)
      SELECT chat_id,generation,user_id,attempt,? FROM questionnaire_progress WHERE chat_id=? AND user_id='vk:41'`,
      )
      .run(old.conversation_message_id, chat);
    await app.restart(true);
    app.at(3_000);
    app.submit('/анкета', 42);
    const status = () =>
      app.db
        .prepare("SELECT state FROM questionnaire_progress WHERE chat_id=? AND user_id='vk:42'")
        .pluck()
        .get(chat);
    await until(() => expect(status()).toBe('active'));
    const sent = app.sends.length;
    for (const id of [
      app.submit('/анкета представить', 41),
      app.submit('Представить', 41, old),
      app.submit('Не представлять', 42, old),
    ])
      await app.journaled(id);
    expect(status()).toBe('active');
    expect(app.sends).toHaveLength(sent);
    expect(introductions(app)).toEqual([]);
    expect(app.complete).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
  }
});
