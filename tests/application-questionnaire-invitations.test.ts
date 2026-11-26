import { lifecycleBackend } from '../src/storage/lifecycle-store';
import { legacyQuestionnaire } from '../src/core/questionnaires/legacy-template';
import { privateQuestionnaireHint } from '../src/core/questionnaire/text';
import { expect, test } from 'vitest';
import {
  answer,
  chat,
  fixture,
  mention,
  peer,
  until,
} from './helpers/application-response-fixture';
import { chatControlStore } from '../src/storage/chat-control-store';
import { participantRegistryStore } from '../src/storage/participant-registry';
import { personalDataStore } from '../src/storage/personal-data-store';
import type { UserId } from '../src/contracts/index';
import type { QuestionnaireInvitationSource } from '../src/core/greetings/invitation';
import { seedBeforeQuestionnaires, seedLegacyPrivateForm } from './helpers/questionnaire-upgrade';
import { questionnaireStore } from '../src/storage/questionnaire-store';
import { vkMessageLength } from '../src/channels/vk/outbound-text';
import { questionnaireHour } from '../src/storage/questionnaire-input';

type App = Awaited<ReturnType<typeof fixture>>;
const hello = 'Рады видеть в лесу! [id999|чужой]';
const action = '/анкета';
const instruction = 'Ваши ответы увидят все участники этой беседы.';
const defaultList = legacyQuestionnaire.questions.map(({ text }) => text).join('\n');
const invitations = (app: App) => app.sends.filter(({ text }) => text.includes(instruction));
const welcomes = (app: App) =>
  app.sends.filter(({ text }) => text === hello || text.includes(instruction));
const states = (app: App) =>
  app.db
    .prepare('SELECT state,invitation_state AS invitation FROM greeting_windows ORDER BY id')
    .all();
const open = (app: App, count = 1) => until(() => expect(states(app)).toHaveLength(count));

const form = (app: App, user = 101) =>
  app.db
    .prepare(
      'SELECT attempt,state,shown_at,shown_message_id FROM questionnaire_progress WHERE chat_id=? AND user_id=?',
    )
    .get(app.scope.chatId, 'vk:' + user);

function modelAnswers(app: App, answers: Record<string, string | null>) {
  app.complete.mockResolvedValueOnce({
    kind: 'complete',
    text: JSON.stringify(answers),
    usage: { input: 20, output: 10 },
  });
}

async function replaceQuestions(app: App, questions: readonly string[], enable = false) {
  const before = app.sends.length;
  app.submit(enable ? '/приглашение вкл' : '/анкета вопросы изменить', 73);
  const find = () =>
    app.sends.slice(before).find(({ text }) => text.includes('по одному вопросу на строку'));
  await until(() => expect(find()).toBeDefined());
  app.submit(questions.join('\n'), 73, find()!);
  if (questions.length === 1) {
    const proposal = () =>
      app.sends.slice(before).find(({ text }) => text.includes('останется 1.'));
    await until(() => expect(proposal()).toBeDefined());
    app.submit('Заменить', 73, proposal()!);
  }
  await until(() =>
    expect(
      questionnaireStore(app.storage)
        .current(app.scope)
        ?.questions.map(({ text }) => text),
    ).toEqual(questions),
  );
}

function engine() {
  const completed = new Set<string>();
  const source: Pick<QuestionnaireInvitationSource, 'state'> = {
    state: (scope, user) => (completed.has(scope.chatId + '/' + user) ? 'completed' : 'available'),
  };
  return {
    source,
    finish(chatId: string, user: UserId) {
      completed.add(chatId + '/' + user);
    },
  };
}

async function configure(app: App, greet: boolean, invite: boolean) {
  await until(() =>
    expect(participantRegistryStore(app.storage).read(app.scope).lastAttemptComplete).toBe(true),
  );
  if (greet) {
    const added = await app.storage.versions.append(app.scope, {
      kind: 'greeting_template',
      key: 'welcome',
      text: hello + '\n{анкета}',
      createdAt: app.start,
      expectedHead: null,
    });
    if (added.status !== 'created') throw Error('Нет шаблона приветствия.');
    await app.storage.versions.select(app.scope, 'greeting_template', added.value.ref, null);
    app.submit('/приветствие вкл', 73);
  }
  if (invite) app.submit('/приглашение вкл', 73);
  await until(() => {
    const state = chatControlStore(app.storage).read(app.scope);
    expect(state.greetingEnabledAt !== null).toBe(greet);
    expect(state.invitationEnabledAt !== null).toBe(invite);
  });
  expect(welcomes(app)).toEqual([]);
  expect(states(app)).toEqual([]);
}

function enter(app: App, user = 101, members = [73, user], offset = 1000) {
  app.at(offset);
  app.setMembers(members);
  return app.membership('chat_invite_user_by_link', user);
}

test.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])('сочетание приветствия %s и приглашения %s', async (greet, invite) => {
  const { source } = engine();
  const app = await fixture({ greetings: { members: [73], questionnaire: source } });
  try {
    await configure(app, greet, invite);
    app.name(101, 'Саша', 'Иванов');
    const joined = enter(app);
    if (greet || invite) {
      await open(app);
      app.at(31000);
      await until(() =>
        expect(states(app)).toEqual([
          {
            state: greet ? 'delivered' : 'skipped',
            invitation: invite ? 'delivered' : 'skipped',
          },
        ]),
      );
    } else {
      await until(() =>
        expect(participantRegistryStore(app.storage).read(app.scope).participants).toContainEqual(
          expect.objectContaining({ userId: 'vk:101', status: 'present' }),
        ),
      );
      app.at(31000);
      expect(states(app)).toEqual([]);
    }
    app.replay(joined);
    expect(
      welcomes(app).map(({ text, disableMentions, peer_id }) => [text, disableMentions, peer_id]),
    ).toEqual([
      ...(greet ? [[hello, 1, peer]] : []),
      ...(invite ? [[expect.stringContaining('[id101|Саша Иванов]'), 0, peer]] : []),
    ]);
    expect(app.complete).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

test('приглашение ждёт квитанции и пересчитывает адресатов после ожидания VK', async () => {
  const { source, finish } = engine();
  const app = await fixture({
    hold: true,
    greetings: { members: [73, 103], questionnaire: source },
  });
  try {
    await configure(app, true, true);
    finish(app.scope.chatId, 'vk:103');
    finish('vk:2000000099', 'vk:102');
    app.name(101, 'Саша', 'Иванов');
    app.name(102, 'Саша', 'Иванов');
    app.name(104, 'Ира][id999|Ирина', '[@id888]');
    app.at(500);
    app.setMembers([73]);
    app.membership('chat_kick_user', 103, 103);
    await until(() =>
      expect(['left', 'absent']).toContain(
        participantRegistryStore(app.storage)
          .read(app.scope)
          .participants.find((member) => member.userId === 'vk:103')?.status,
      ),
    );
    enter(app, 101);
    await open(app);
    enter(app, 102, [73, 101, 102], 2000);
    enter(app, 103, [73, 101, 102, 103], 3000);
    enter(app, 104, [73, 101, 102, 103, 104], 4000);
    await until(() =>
      expect(app.db.prepare('SELECT count(*) FROM greeting_members').pluck().get()).toBe(4),
    );
    const receipt = app.holdReceipt((text) => text === hello);
    app.at(31000);
    await until(() => expect(app.holds).toHaveLength(1));
    app.holds[0]!.release();
    await until(() => expect(welcomes(app)).toHaveLength(1));
    await receipt.entered;
    expect(states(app)).toEqual([{ state: 'dispatching', invitation: 'waiting' }]);
    expect(invitations(app)).toEqual([]);
    receipt.release();
    await until(() => expect(app.holds).toHaveLength(2));
    finish(app.scope.chatId, 'vk:101');
    app.holds[1]!.release();
    await until(() =>
      expect(states(app)).toEqual([{ state: 'delivered', invitation: 'delivered' }]),
    );
    const [sent] = invitations(app);
    expect(sent?.text).toContain('[id102|Саша Иванов]');
    expect(sent?.text).toContain('[id104|');
    expect(sent?.text.match(/\[id\d+\|/gu)).toEqual(['[id102|', '[id104|']);
    expect(sent?.sendId).not.toBe(welcomes(app)[0]!.sendId);

    const privacy = personalDataStore(app.storage);
    expect(
      privacy.export(app.scope, 'vk:102', Date.now()).serviceRecords.invitationEntries,
    ).toEqual([expect.objectContaining({ state: 'delivered' })]);
    const deletion = privacy.requestDeletion(app.scope, 'vk:102', 'test-invite', Date.now());
    expect(privacy.confirmDeletion(app.scope, 'vk:102', deletion.code, Date.now())).toBe(true);
    expect(
      app.db
        .prepare(
          'SELECT platform_message_id FROM personal_visible_messages WHERE platform_message_id=?',
        )
        .get(String(sent!.conversation_message_id)),
    ).toBeUndefined();
  } finally {
    await app.close();
  }
});

test.each([
  'без допуска профиля',
  'отказ приветствия',
  'неизвестное приветствие',
  'выключение приветствия',
  'выключение приглашений',
  'лимит',
] as const)('нет второго сообщения при условии «%s»', async (reason) => {
  const { source } = engine();
  const stopBeforeInvite = reason.startsWith('выключение');
  const app = await fixture({
    hold: stopBeforeInvite,
    limit: reason === 'лимит' ? 1 : 6,
    greetings: {
      members: [73],
      ...(reason === 'без допуска профиля' ? {} : { questionnaire: source }),
    },
  });
  try {
    await configure(app, true, true);
    if (reason === 'отказ приветствия' || reason === 'неизвестное приветствие')
      app.failSend((text) =>
        text === hello
          ? reason === 'отказ приветствия'
            ? 901
            : 'unknownAfterDelivery'
          : undefined,
      );
    enter(app);
    await open(app);
    app.at(31000);
    if (stopBeforeInvite) {
      await until(() => expect(app.holds).toHaveLength(1));
      app.holds[0]!.release();
      await until(() => expect(app.holds).toHaveLength(2));
      app.submit(
        reason === 'выключение приветствия' ? '/приветствие выкл' : '/приглашение выкл',
        73,
      );
      await until(() => {
        const state = chatControlStore(app.storage).read(app.scope);
        expect(
          reason === 'выключение приветствия' ? state.greetingEnabledAt : state.invitationEnabledAt,
        ).toBeNull();
      });
      app.holds[1]!.release();
    }
    const greetingState =
      reason === 'отказ приветствия'
        ? 'skipped'
        : reason === 'неизвестное приветствие'
          ? 'unknown'
          : 'delivered';
    await until(() =>
      expect(states(app)).toEqual([{ state: greetingState, invitation: 'skipped' }]),
    );
    expect(invitations(app)).toEqual([]);
    expect(app.complete).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

test('перезапуск между отправками, неизвестный исход второго сообщения и повтор сигнала', async () => {
  const { source, finish } = engine();
  const app = await fixture({ hold: true, greetings: { members: [73], questionnaire: source } });
  try {
    await configure(app, true, true);
    const event = enter(app);
    await open(app);
    app.at(31000);
    await until(() => expect(app.holds).toHaveLength(1));
    app.holds[0]!.release();
    await until(() => expect(app.holds).toHaveLength(2));
    expect(states(app)).toEqual([{ state: 'delivered', invitation: 'waiting' }]);
    await app.restart(true);
    await until(() => expect(app.holds).toHaveLength(3));
    app.failSend((text) => (text.includes(instruction) ? 'unknownAfterDelivery' : undefined));
    app.holds[2]!.release();
    await until(() => expect(states(app)).toEqual([{ state: 'delivered', invitation: 'unknown' }]));
    expect(welcomes(app)).toHaveLength(2);
    await app.restart(true);
    app.replay(event);
    finish(app.scope.chatId, 'vk:101');
    app.at(32000);
    app.setMembers([73]);
    app.membership('chat_kick_user', 101, 101);
    await until(() =>
      expect(['left', 'absent']).toContain(
        participantRegistryStore(app.storage)
          .read(app.scope)
          .participants.find((member) => member.userId === 'vk:101')?.status,
      ),
    );
    enter(app, 101, [73, 101], 33000);
    await open(app, 2);
    app.at(63000);
    await until(() => expect(app.holds).toHaveLength(4));
    app.holds[3]!.release();
    await until(() =>
      expect(states(app)).toEqual([
        { state: 'delivered', invitation: 'unknown' },
        { state: 'delivered', invitation: 'skipped' },
      ]),
    );
    expect(invitations(app)).toHaveLength(1);
    expect(welcomes(app)).toHaveLength(3);

    app.submit('/приветствие выкл', 73);
    await until(() =>
      expect(chatControlStore(app.storage).read(app.scope).greetingEnabledAt).toBeNull(),
    );
    app.at(64000);
    app.setMembers([73]);
    app.membership('chat_kick_user', 101, 101);
    await until(() =>
      expect(['left', 'absent']).toContain(
        participantRegistryStore(app.storage)
          .read(app.scope)
          .participants.find((member) => member.userId === 'vk:101')?.status,
      ),
    );
    enter(app, 101, [73, 101], 65000);
    await open(app, 3);
    app.at(95000);
    await until(() => expect(states(app)[2]).toEqual({ state: 'skipped', invitation: 'skipped' }));
    expect(invitations(app)).toHaveLength(1);
    expect(welcomes(app)).toHaveLength(3);
  } finally {
    await app.close();
  }
});

test('выход перед отправкой исключает ожидающего адресата', async () => {
  const { source } = engine();
  const app = await fixture({ hold: true, greetings: { members: [73], questionnaire: source } });
  try {
    await configure(app, false, true);
    enter(app);
    await open(app);
    app.at(31000);
    await until(() => expect(app.holds).toHaveLength(1));
    app.at(32000);
    app.setMembers([73]);
    app.membership('chat_kick_user', 101, 101);
    await until(() =>
      expect(['left', 'absent']).toContain(
        participantRegistryStore(app.storage)
          .read(app.scope)
          .participants.find((member) => member.userId === 'vk:101')?.status,
      ),
    );
    app.holds[0]!.release();
    await until(() => expect(states(app)).toEqual([{ state: 'skipped', invitation: 'skipped' }]));
    expect(invitations(app)).toEqual([]);
  } finally {
    await app.close();
  }
});

test('выключение бота убирает ожидающее приглашение без поздней рассылки', async () => {
  const { source } = engine();
  const app = await fixture({ greetings: { members: [73], questionnaire: source } });
  try {
    await configure(app, false, true);
    enter(app);
    await open(app);
    await app.storage.chats.update(app.scope, { enabled: false });
    await app.storage.chats.update(app.scope, { enabled: true });
    app.at(31000);
    await until(() => expect(states(app)).toEqual([{ state: 'skipped', invitation: 'skipped' }]));
    expect(welcomes(app)).toEqual([]);
  } finally {
    await app.close();
  }
});

test.each([false, true])(
  'штатное приглашение ведёт к прохождению и учитывает завершение, приветствие %s',
  async (greet) => {
    const app = await fixture({
      profileNotice: 'Обработка анкеты и профиля.',
      greetings: { members: [73, 102] },
    });
    try {
      await configure(app, greet, true);
      app.name(101, 'Саша', 'Иванов');
      app.name(102, 'Саша', 'Иванов');
      enter(app, 101, [73, 101, 102]);
      await open(app);
      const confirmation = greet ? app.holdReceipt((text) => text === hello) : undefined;
      app.at(31_000);
      if (confirmation) {
        await confirmation.entered;
        expect(welcomes(app).map(({ text }) => text)).toEqual([hello]);
        confirmation.release();
      }
      await until(() => expect(states(app)[0]).toMatchObject({ invitation: 'delivered' }));
      expect(invitations(app)).toHaveLength(1);
      const invite = invitations(app)[0]!;
      expect(invite.text).toContain('[id101|Саша Иванов]');
      expect(invite.text).not.toContain('[id102|');
      expect(invite.disableMentions).toBe(0);
      expect(welcomes(app).map(({ text }) => text)).toEqual(
        greet ? [hello, invite.text] : [invite.text],
      );
      const progress = () =>
        app.db
          .prepare('SELECT state FROM questionnaire_progress WHERE chat_id=? AND user_id=?')
          .get(app.scope.chatId, 'vk:101');
      expect(progress()).toBeUndefined();
      expect(invite.text.endsWith(defaultList)).toBe(true);
      app.complete.mockResolvedValueOnce({
        kind: 'complete',
        text: JSON.stringify(
          Object.fromEntries(
            legacyQuestionnaire.questions.map((q) => [q.position, q.position === 2 ? 'Аня' : null]),
          ),
        ),
        usage: { input: 20, output: 10 },
      });
      app.at(33_000);
      const answerId = app.submit('Я Аня. Остальное пропущу.', 101, invite);
      await until(() =>
        expect(app.sends.some((s) => s.text.startsWith('Спасибо! Анкета заполнена.'))).toBe(true),
      );
      expect(progress()).toEqual({ state: 'completed' });
      expect(
        app.db
          .prepare(
            `SELECT q.position,f.value FROM questionnaire_answer_facts q
        JOIN profile_facts f ON f.id=q.fact_id WHERE q.chat_id=? AND q.user_id=?`,
          )
          .all(app.scope.chatId, 'vk:101'),
      ).toEqual([{ position: 2, value: 'Аня' }]);
      expect(
        app.db
          .prepare(
            `SELECT 1 FROM profile_update_waiting w JOIN messages m ON m.id=w.message_id
         WHERE w.chat_id=? AND m.platform_message_id=?`,
          )
          .get(app.scope.chatId, String(answerId)),
      ).toBeUndefined();
      if (!greet) await app.restart(true);
      app.at(34_000);
      app.setMembers([73, 102]);
      app.membership('chat_kick_user', 101, 101);
      await until(() =>
        expect(
          participantRegistryStore(app.storage)
            .read(app.scope)
            .participants.find((p) => p.userId === 'vk:101')?.status,
        ).not.toBe('present'),
      );
      enter(app, 101, [73, 101, 102], 35_000);
      await open(app, 2);
      app.at(65_000);
      await until(() => expect(states(app)[1]).toMatchObject({ invitation: 'skipped' }));
      expect(invitations(app)).toHaveLength(1);
      expect(app.complete).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  },
);

test('прежняя заполненная личная анкета оставляет штатное приглашение беседы доступным', async () => {
  const app = await fixture({
    profileNotice: 'Обработка анкеты и профиля.',
    greetings: { members: [73] },
  });
  try {
    await configure(app, false, true);
    app.at(1000);
    app.submit(action, 101, undefined, 101);
    await until(() =>
      expect(
        app.sends.some(({ peer_id, text }) => peer_id === 101 && text === privateQuestionnaireHint),
      ).toBe(true),
    );
    seedLegacyPrivateForm(app.db, lifecycleBackend(app.storage).current('vk:101'), app.start, {
      '1': 'Аня',
    });
    enter(app, 101, [73, 101], 4000);
    await open(app);
    app.at(34_000);
    await until(() => expect(invitations(app)).toHaveLength(1));
    expect(invitations(app)[0]).toMatchObject({
      peer_id: peer,
      text: expect.stringContaining('[id101|'),
    });
    expect(
      app.db
        .prepare("SELECT state FROM questionnaire_progress WHERE chat_id=? AND user_id='vk:101'")
        .get(app.scope.chatId),
    ).toBeUndefined();
  } finally {
    await app.close();
  }
});

test.each(['стартовая редакция прежней группы', 'участник отказался от профилирования'] as const)(
  'штатное приглашение учитывает доступность — %s',
  async (reason) => {
    const app = await fixture({
      profileNotice: 'Обработка анкеты и профиля.',
      greetings: { members: [73] },
      ...(reason === 'стартовая редакция прежней группы'
        ? { existingChat: (path: string) => seedBeforeQuestionnaires(path, [chat], true) }
        : {}),
    });
    try {
      if (reason === 'стартовая редакция прежней группы') {
        await until(() =>
          expect(participantRegistryStore(app.storage).read(app.scope).lastAttemptComplete).toBe(
            true,
          ),
        );
      } else {
        await configure(app, false, true);
        personalDataStore(app.storage).disable(app.scope, 'vk:101', Date.now());
      }
      enter(app);
      await open(app);
      app.at(31_000);
      if (reason === 'стартовая редакция прежней группы') {
        await until(() =>
          expect(states(app)).toEqual([{ state: 'skipped', invitation: 'delivered' }]),
        );
        expect(invitations(app)).toHaveLength(1);
        expect(invitations(app)[0]?.text.endsWith(defaultList)).toBe(true);
      } else {
        await until(() =>
          expect(states(app)).toEqual([{ state: 'skipped', invitation: 'skipped' }]),
        );
        expect(invitations(app)).toEqual([]);
      }
    } finally {
      await app.close();
    }
  },
);

test('двое отвечают на одну редакцию после полуночи, замены вопросов, отключения и рестарта', async () => {
  const app = await fixture({
    startAt: Date.UTC(2026, 10, 25, 23, 59, 40),
    profileNotice: 'Обработка анкеты и профиля.',
    greetings: { members: [73, 105] },
  });
  try {
    await until(() =>
      expect(participantRegistryStore(app.storage).read(app.scope).lastAttemptComplete).toBe(true),
    );
    const original = ['Как тебя зовут?', 'Какая игра нравится?'];
    await replaceQuestions(app, original, true);
    const firstEntry = enter(app, 101, [73, 105, 101]);
    await open(app);
    enter(app, 102, [73, 105, 101, 102], 2_000);
    await until(() =>
      expect(app.db.prepare('SELECT count(*) FROM greeting_members').pluck().get()).toBe(2),
    );
    app.at(31_000);
    await until(() => expect(states(app)[0]).toMatchObject({ invitation: 'delivered' }));
    const [list] = invitations(app);
    expect(list?.text).toContain('[id101|');
    expect(list?.text).toContain('[id102|');
    expect(list?.text.endsWith(original.join('\n'))).toBe(true);
    expect([form(app, 101), form(app, 102)]).toEqual([undefined, undefined]);
    app.replay(firstEntry);
    await app.journaled(app.submit('Поболтаем о погоде', 101));
    await app.journaled(app.submit('Я не адресат', 105, list));
    expect(app.complete).not.toHaveBeenCalled();
    expect(form(app, 105)).toBeUndefined();

    app.at(32_000);
    await replaceQuestions(app, ['Назови город', 'Любимый фильм?']);
    app.submit('/приглашение выкл', 73);
    await until(() =>
      expect(chatControlStore(app.storage).read(app.scope).invitationEnabledAt).toBeNull(),
    );
    modelAnswers(app, { 1: 'Аня', 2: null });
    const first = app.submit('Аня', 101, list);
    await app.published(first);
    await app.restart(true);
    app.at(33_000);
    app.replay(first);
    modelAnswers(app, { 1: null, 2: 'Шахматы' });
    await app.published(app.submit('Шахматы', 102, list));
    expect(app.complete).toHaveBeenCalledTimes(2);
    expect(
      app.db
        .prepare(
          'SELECT a.user_id,a.question,f.value FROM questionnaire_answer_facts a JOIN profile_facts f ON f.id=a.fact_id ORDER BY a.user_id',
        )
        .all(),
    ).toEqual([
      { user_id: 'vk:101', question: original[0], value: 'Аня' },
      { user_id: 'vk:102', question: original[1], value: 'Шахматы' },
    ]);
    app.submit('/анкета [id101|Аня]', 105);
    await until(() => expect(app.sends.at(-1)?.text).toContain(original[0] + '\nАня'));
    app.submit('/анкета', 105);
    await until(() => expect(form(app, 105)).toMatchObject({ state: 'active' }));
    expect(app.sends.at(-1)?.text).toContain('Назови город\nЛюбимый фильм?');
  } finally {
    await app.close();
  }
});

test.each(['warning', 'questions'] as const)(
  'поздняя квитанция части %s переживает рестарт с тем же ID',
  async (stage) => {
    const vkSends: Record<string, string | number>[] = [];
    const app = await fixture({
      profileNotice: 'Обработка анкеты и профиля.',
      greetings: { members: [73] },
      beforeVkRequest: async (method, args) => {
        if (method === 'messages.send') vkSends.push(args);
      },
    });
    const sample = '[id999|Имя] https://example.test ';
    const base =
      sample + 'я'.repeat(Math.floor((vkMessageLength.value - Buffer.byteLength(sample)) / 2));
    const question = Buffer.byteLength(base) === vkMessageLength.value ? base : base + '?';
    const withheld = app.holdReceipt(
      stage === 'warning' ? (t) => t.includes(instruction) : (t) => t === question,
    );
    try {
      await configure(app, false, true);
      await replaceQuestions(app, [question]);
      enter(app);
      await open(app);
      app.at(31_000);
      await withheld.entered;
      const saved = app.db.prepare(
        'SELECT send_id,receipt,state FROM questionnaire_invitation_parts WHERE stage=?',
      );
      const pending = saved.get(stage);
      expect(pending).toMatchObject({ state: 'sending', receipt: expect.any(Number) });
      await app.restart(true, [], { retainReceipt: true });
      expect(saved.get(stage)).toMatchObject({ ...(pending as object), state: 'unknown' });
      app.at(32_000);
      withheld.release();
      await until(() => expect(states(app)[0]).toMatchObject({ invitation: 'delivered' }));

      const warning = invitations(app)[0]!;
      const list = app.sends.find(({ text }) => text === question)!;
      expect(
        app.sends.filter(({ text }) => text.includes(instruction) || text === question),
      ).toEqual([warning, list]);
      expect(warning.disableMentions).toBe(0);
      expect(warning.text).not.toContain('[id999|');
      expect(vkSends.find(({ message }) => message === question)).toMatchObject({
        dont_parse_links: 1,
        disable_mentions: 1,
        peer_ids: String(peer),
      });
      expect(list.sendId).not.toBe(warning.sendId);
      expect(saved.get(stage)).toMatchObject({ ...(pending as object), state: 'delivered' });
      const confirmed = app.db
        .prepare("SELECT confirmed_at FROM questionnaire_invitation_parts WHERE stage='questions'")
        .pluck()
        .get() as number;
      expect(confirmed).toBe(app.start + 32_000);
      const before = app.sends.length;
      await app.journaled(app.submit('Ответ на пояснение', 101, warning));
      await until(() =>
        expect(
          app.sends
            .slice(before)
            .some(({ text }) => text.includes('Ответьте на сообщение с вопросами или')),
        ).toBe(true),
      );
      expect(form(app)).toBeUndefined();

      app.at(confirmed - app.start + questionnaireHour);
      const stale = app.submit('Поздний ответ', 101, list);
      await until(() =>
        expect(app.sends.at(-1)?.text).toContain('Список больше не принимает ответы.'),
      );
      app.replay(stale);
      expect(form(app)).toBeUndefined();
      expect(app.complete).not.toHaveBeenCalled();
    } finally {
      withheld.release();
      await app.close();
    }
  },
);

test('переполнение очереди не занимает попытку, повтор использует редакцию полученного списка', async () => {
  const app = await fixture({
    profileNotice: 'Обработка анкеты и профиля.',
    greetings: { members: [73] },
  });
  const release = Promise.withResolvers<void>();
  try {
    await configure(app, false, true);
    await replaceQuestions(app, ['Имя?', 'Город?']);
    enter(app);
    await open(app);
    app.at(31_000);
    await until(() => expect(states(app)[0]).toMatchObject({ invitation: 'delivered' }));
    const list = invitations(app)[0]!;
    app.complete.mockImplementationOnce(async () => {
      await release.promise;
      return answer;
    });
    app.at(32_000);
    app.submit(mention + ' 1', 73);
    await until(() => expect(app.complete).toHaveBeenCalledTimes(1));
    app.submit(mention + ' 2', 73);
    app.submit(mention + ' 3', 73);
    const queued = () =>
      app.db.prepare("SELECT count(*) FROM queue_jobs WHERE state='queued'").pluck().get();
    await until(() => expect(queued()).toBe(2));
    const rejected = app.submit('Я Аня', 101, list);
    await app.published(rejected);
    expect(form(app)).toBeUndefined();
    expect(app.db.prepare('SELECT count(*) FROM questionnaire_inputs').pluck().get()).toBe(0);
    release.resolve();
    await until(() => expect(app.complete).toHaveBeenCalledTimes(3));
    await until(() => expect(queued()).toBe(0));

    app.at(93_000);
    modelAnswers(app, { 1: 'Аня', 2: null });
    await app.published(app.submit('Я Аня', 101, list));
    expect(form(app)).toMatchObject({ state: 'completed' });
    expect(app.db.prepare('SELECT count(*) FROM questionnaire_inputs').pluck().get()).toBe(1);
  } finally {
    release.resolve();
    await app.close();
  }
});

test('ручное заполнение использует одну попытку, отмена и новое поколение закрывают старую квитанцию', async () => {
  const app = await fixture({
    profileNotice: 'Обработка анкеты и профиля.',
    greetings: { members: [73] },
  });
  try {
    await configure(app, false, true);
    await replaceQuestions(app, ['Имя?', 'Город?']);
    enter(app);
    await open(app);
    enter(app, 102, [73, 101, 102], 2_000);
    await until(() =>
      expect(app.db.prepare('SELECT count(*) FROM greeting_members').pluck().get()).toBe(2),
    );
    app.at(31_000);
    await until(() => expect(states(app)[0]).toMatchObject({ invitation: 'delivered' }));
    const list = invitations(app)[0]!;
    app.at(32_000);
    app.submit('/анкета', 101);
    app.submit('/анкета', 102);
    await until(() =>
      expect([form(app, 101), form(app, 102)]).toEqual([
        expect.objectContaining({ state: 'active' }),
        expect.objectContaining({ state: 'active' }),
      ]),
    );
    const first = form(app, 101) as { attempt: string };
    const cancelled = form(app, 102) as { attempt: string };
    modelAnswers(app, { 1: 'Аня', 2: null });
    await app.published(app.submit('Аня', 101, list));
    expect(form(app, 101)).toMatchObject({ attempt: first.attempt, state: 'completed' });
    app.submit('/анкета отмена', 102);
    await until(() => expect(form(app, 102)).toBeUndefined());
    app.submit('/анкета', 102);
    await until(() => expect(form(app, 102)).toMatchObject({ state: 'active' }));
    const fresh = form(app, 102);
    expect(fresh).not.toMatchObject({ attempt: cancelled.attempt });
    app.submit('По старому списку', 102, list);
    await until(() =>
      expect(app.sends.at(-1)?.text).toContain('Список больше не принимает ответы.'),
    );
    expect(form(app, 102)).toEqual(fresh);
    expect(app.complete).toHaveBeenCalledOnce();

    const replacement = await app.connectGroup(peer);
    expect(replacement.generation).not.toBe(app.scope.generation);
    const stale = app.submit('Со старой квитанцией', 102, list);
    await until(() =>
      expect(
        app.db
          .prepare('SELECT purpose FROM messages WHERE chat_id=? AND platform_message_id=?')
          .pluck()
          .get(chat, String(stale)),
      ).toBe('service_notice'),
    );
    expect(form(app, 102)).toBeUndefined();
    expect(app.complete).toHaveBeenCalledOnce();
  } finally {
    await app.close();
  }
});

test.each([901, 'unknownAfterDelivery'] as const)(
  'отказ списка %s сохраняет подтверждённое пояснение и не открывает час',
  async (failure) => {
    const app = await fixture({
      profileNotice: 'Обработка анкеты и профиля.',
      greetings: { members: [73] },
    });
    const questions = ['[id999|Имя] https://example.test', 'Второй вопрос?'];
    const list = questions.join('\n');
    try {
      await configure(app, false, true);
      await replaceQuestions(app, questions);
      app.failSend((text) => (text === list ? failure : undefined));
      const joined = enter(app);
      await open(app);
      app.at(31_000);
      const definite = failure === 901;
      await until(() =>
        expect(states(app)[0]).toMatchObject({ invitation: definite ? 'skipped' : 'unknown' }),
      );
      const parts = () =>
        app.db
          .prepare(
            'SELECT stage,state,send_id,confirmed_at FROM questionnaire_invitation_parts ORDER BY stage DESC',
          )
          .all();
      const saved = parts();
      expect(saved).toEqual([
        expect.objectContaining({
          stage: 'warning',
          state: 'delivered',
          confirmed_at: app.start + 31_000,
        }),
        expect.objectContaining({
          stage: 'questions',
          state: definite ? 'failed' : 'unknown',
          confirmed_at: null,
        }),
      ]);
      await app.restart(true);
      app.at(32_000);
      app.replay(joined);
      expect(invitations(app)).toHaveLength(1);
      expect(app.sends.filter(({ text }) => text === list)).toHaveLength(definite ? 0 : 1);
      expect(parts()).toEqual(saved);
      expect(form(app)).toBeUndefined();
      expect(app.complete).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  },
);
