import { lifecycleBackend } from '../src/storage/lifecycle-store';
import { legacyQuestionnaire } from '../src/core/questionnaires/legacy-template';
import { privateQuestionnaireHint } from '../src/core/questionnaire/text';
import { expect, test } from 'vitest';
import { chat, fixture, peer, until } from './helpers/application-response-fixture';
import { chatControlStore } from '../src/storage/chat-control-store';
import { participantRegistryStore } from '../src/storage/participant-registry';
import { personalDataStore } from '../src/storage/personal-data-store';
import type { UserId } from '../src/contracts/index';
import type { QuestionnaireInvitationSource } from '../src/core/greetings/invitation';
import { seedBeforeQuestionnaires, seedLegacyPrivateForm } from './helpers/questionnaire-upgrade';

type App = Awaited<ReturnType<typeof fixture>>;
const hello = 'Рады видеть в лесу! [id999|чужой]';
const action = '/анкета';
const invitations = (app: App) => app.sends.filter(({ text }) => text.endsWith(action));
const welcomes = (app: App) =>
  app.sends.filter(({ text }) => text === hello || text.endsWith(action));
const states = (app: App) =>
  app.db
    .prepare('SELECT state,invitation_state AS invitation FROM greeting_windows ORDER BY id')
    .all();
const open = (app: App, count = 1) => until(() => expect(states(app)).toHaveLength(count));

function engine() {
  const completed = new Set<string>();
  const source: QuestionnaireInvitationSource = {
    action: () => action,
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
    app.failSend((text) => (text.endsWith(action) ? 'unknownAfterDelivery' : undefined));
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
      await until(() => expect(invitations(app)).toHaveLength(1));
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
      app.at(32_000);
      const command = invite.text.split(' ').at(-1)!;
      expect(command).toBe(action);
      app.submit(command, 101);
      await until(() => expect(progress()).toMatchObject({ state: 'active' }));
      const list = legacyQuestionnaire.questions.map(({ text }) => text).join('\n');
      const shown = app.sends.find(({ text }) => text.startsWith('Ваш ответ увидят участники'));
      expect(shown?.text.endsWith(list)).toBe(true);
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
      const answerId = app.submit('Пенёк, я Аня. Остальное пропущу.', 101);
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
        ? { existingChat: (path: string) => seedBeforeQuestionnaires(path, [chat]) }
        : {}),
    });
    try {
      await configure(app, false, true);
      if (reason === 'участник отказался от профилирования')
        personalDataStore(app.storage).disable(app.scope, 'vk:101', Date.now());
      enter(app);
      await open(app);
      app.at(31_000);
      if (reason === 'стартовая редакция прежней группы') {
        await until(() =>
          expect(states(app)).toEqual([{ state: 'skipped', invitation: 'delivered' }]),
        );
        expect(invitations(app)).toHaveLength(1);
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
