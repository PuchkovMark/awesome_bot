import { expect, test } from 'vitest';
import { fixture, peer, until } from './helpers/application-response-fixture';
import { chatControlStore } from '../src/storage/chat-control-store';
import { participantRegistryStore } from '../src/storage/participant-registry';
import { personalDataStore } from '../src/storage/personal-data-store';
import type { UserId } from '../src/contracts/index';
import type { QuestionnaireInvitationSource } from '../src/core/greetings/invitation';

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
  'без движка',
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
    greetings: { members: [73], ...(reason === 'без движка' ? {} : { questionnaire: source }) },
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
