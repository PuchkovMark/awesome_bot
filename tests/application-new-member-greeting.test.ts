import { expect, test } from 'vitest';
import { fixture, peer, until } from './helpers/application-response-fixture';
import { chatControlStore } from '../src/storage/chat-control-store';
import { personalDataStore } from '../src/storage/personal-data-store';
import { startResponse } from '../src/storage/response-rate-store';
import { participantRegistryStore } from '../src/storage/participant-registry';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const multi = 'Всем привет! Добро пожаловать в беседу!';
const greetings = (f: Fixture) =>
  f.sends.filter(({ text }) => /^(?:Привет[!,]|Всем привет!|С возвращением[!,])/u.test(text));
const windows = (f: Fixture) =>
  f.db
    .prepare(
      'SELECT id,chat_id AS chat,opened_at AS at,due_at AS due,state,send_id AS sendId,message_id AS messageId FROM greeting_windows ORDER BY id',
    )
    .all() as {
    id: number;
    chat: string;
    at: number;
    due: number;
    state: string;
    sendId: number | null;
    messageId: number | null;
  }[];

async function enable(f: Fixture) {
  await until(() =>
    expect(participantRegistryStore(f.storage).read(f.scope).lastAttemptComplete).toBe(true),
  );
  expect(windows(f)).toEqual([]);
  f.submit('/приветствие вкл', 73);
  await until(() =>
    expect(chatControlStore(f.storage).read(f.scope).greetingEnabledAt).not.toBeNull(),
  );
}
function join(f: Fixture, user: number) {
  return f.membership('chat_invite_user_by_link', user);
}
async function waitWindows(f: Fixture, count: number) {
  await until(() => expect(windows(f)).toHaveLength(count));
}

test('первый снимок молчит, входы 0 и 29 вместе, граница 30 отдельно, рестарт и соседняя группа', async () => {
  const f = await fixture({ greetings: { members: [73, 199] } });
  try {
    await enable(f);
    const neighbor = await f.connectGroup(peer + 1);
    expect(chatControlStore(f.storage).read(neighbor).greetingEnabledAt).toBeNull();
    f.name(101, 'Саша', 'Иванов');
    f.name(102, 'Саша', 'Иванов');
    f.name(103, '');
    f.at(1_000);
    f.setMembers([73, 199, 101]);
    const first = join(f, 101);
    await waitWindows(f, 1);
    f.membership('chat_invite_user_by_link', 101, 101, peer + 1);
    f.at(30_000);
    f.setMembers([73, 199, 101, 102]);
    join(f, 102);
    await until(() =>
      expect(f.db.prepare('SELECT count(*) AS count FROM greeting_members').get()).toEqual({
        count: 2,
      }),
    );
    expect(greetings(f)).toEqual([]);
    f.at(31_000);
    f.setMembers([73, 199, 101, 102, 103]);
    const third = join(f, 103);
    await waitWindows(f, 2);
    await until(() => expect(windows(f)[0]?.state).toBe('delivered'));
    expect(greetings(f).map(({ peer_id, text }) => [peer_id, text])).toEqual([[peer, multi]]);
    expect(windows(f)[0]).toMatchObject({
      at: f.start + 1000,
      due: f.start + 31_000,
      sendId: greetings(f)[0]!.sendId,
    });
    await f.restart(true);
    f.replay(first);
    f.replay(third);
    f.at(61_000);
    await until(() => expect(windows(f)[1]?.state).toBe('delivered'));
    expect(greetings(f).map(({ text }) => text)).toEqual([
      multi,
      'Привет! Добро пожаловать в беседу!',
    ]);
    expect(windows(f).map(({ chat }) => chat)).toEqual([f.scope.chatId, f.scope.chatId]);
    expect(
      f.db
        .prepare(
          `SELECT text,purpose FROM messages WHERE id IN (SELECT message_id FROM greeting_windows) ORDER BY id`,
        )
        .all(),
    ).toEqual(greetings(f).map(({ text }) => ({ text, purpose: 'service_notice' })));
    expect(f.complete).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

test('приглашение ждёт полного состава, затем приветствует вернувшегося с доступным профилем', async () => {
  const f = await fixture({
    profileNotice: 'Уведомление о профилях.',
    active: true,
    greetings: { members: [73, 101], rules: 'Берегите лес.' },
  });
  try {
    await enable(f);
    const user = 'vk:101';
    f.name(101, 'Анна');
    f.at(1_000);
    const own = await f.storage.messages.append(f.scope, {
      chatId: f.scope.chatId,
      userId: user,
      messageId: 'profile',
      timestamp: f.start + 1000,
      text: 'Профиль',
      authorName: 'Анна',
      senderBot: false,
      role: 'user',
    });
    await f.storage.authorization.transaction(f.scope, (tx) => {
      expect(
        tx.changeProfileFact(user, {
          subjectId: user,
          messageId: own.id,
          change: {
            kind: 'set',
            fieldKey: 'place',
            value: 'Закрытый профиль',
            reliability: 'confirmed',
          },
        }),
      ).toBe('recorded');
      expect(
        tx.changeProfileFact(user, {
          subjectId: user,
          messageId: own.id,
          change: { kind: 'visibility', fieldKey: 'place', visibility: 'bot' },
        }),
      ).toBe('recorded');
    });
    const template = await f.storage.versions.append(f.scope, {
      kind: 'greeting_template',
      key: 'welcome',
      text: '{приветствие} {персонаж} {правила} {профиль} {анкета}',
      createdAt: f.start,
      expectedHead: null,
    });
    const persona = await f.storage.versions.append(f.scope, {
      kind: 'persona',
      key: 'local',
      text: 'Лесной сторож.',
      createdAt: f.start,
      expectedHead: null,
    });
    if (template.status !== 'created' || persona.status !== 'created')
      throw Error('Нет версии материалов.');
    await f.storage.versions.select(f.scope, 'greeting_template', template.value.ref, null);
    await f.storage.versions.select(f.scope, 'persona', persona.value.ref, null);
    f.setMembers([73]);
    f.membership('chat_kick_user', 101, 101);
    await until(() =>
      expect(
        participantRegistryStore(f.storage)
          .read(f.scope)
          .participants.find(({ userId }) => userId === user)?.status,
      ).toBe('left'),
    );
    f.at(2_000);
    f.setMembers(null);
    f.membership('chat_invite_user', 73, 101);
    await until(() => {
      expect(f.db.prepare('SELECT user_id FROM greeting_candidates').all()).toEqual([
        { user_id: user },
      ]);
      expect(participantRegistryStore(f.storage).read(f.scope).lastAttemptComplete).toBe(false);
    });
    expect(windows(f)).toEqual([]);
    f.at(3_000);
    f.setMembers([73, 101, 199]);
    f.membership('chat_invite_user', 73);
    await waitWindows(f, 1);
    f.at(33_000);
    await until(() => expect(windows(f)[0]?.state).toBe('delivered'));
    expect(greetings(f).map(({ text }) => text)).toEqual([
      'С возвращением, Анна! Лесной сторож. Берегите лес.',
    ]);
  } finally {
    await f.close();
  }
});

test.each([
  'настройка',
  'пауза',
  'тихие часы',
  'silent',
  'выключение',
  'выход',
  'поколение',
] as const)('ожидающее приветствие пропускается при изменении «%s»', async (condition) => {
  const f = await fixture({ greetings: { members: [73] } });
  try {
    await enable(f);
    await f.storage.chats.update(f.scope, { timezone: 'UTC' });
    f.at(31_000);
    f.setMembers([73, 101]);
    join(f, 101);
    await waitWindows(f, 1);
    if (condition === 'настройка') {
      f.submit('/приветствие выкл', 73);
      await until(() => expect(windows(f)[0]?.state).toBe('skipped'));
      f.submit('/приветствие вкл', 73);
      await until(() =>
        expect(chatControlStore(f.storage).read(f.scope).greetingEnabledAt).not.toBeNull(),
      );
    } else if (condition === 'пауза') {
      await f.storage.authorization.transaction(f.scope, (tx) =>
        tx.writePause({
          pausedUntil: f.start + 90_000,
          nextParticipantPause: null,
          autonomousDisabled: false,
        }),
      );
    } else if (condition === 'тихие часы') {
      await f.storage.authorization.transaction(f.scope, (tx) =>
        tx.writeQuietHours({ start: 721, end: 722 }),
      );
    } else if (condition === 'silent') {
      await f.storage.chats.update(f.scope, { responseMode: 'silent' });
    } else if (condition === 'выключение') {
      await f.storage.chats.update(f.scope, { enabled: false });
    } else if (condition === 'поколение') {
      f.membership('chat_kick_user', 73, -314);
      await until(() =>
        expect(
          f.db.prepare('SELECT state FROM chat_connections WHERE chat_id=?').get(f.scope.chatId),
        ).toEqual({ state: 'uncertain' }),
      );
      const replacement = await f.connectGroup(peer);
      expect(replacement.generation).not.toBe(f.scope.generation);
      expect(chatControlStore(f.storage).read(replacement).greetingEnabledAt).toBeNull();
      await waitWindows(f, 0);
    } else {
      f.at(32_000);
      f.setMembers([73]);
      f.membership('chat_kick_user', 101, 101);
      await until(() =>
        expect(f.db.prepare('SELECT user_id FROM greeting_members').all()).toEqual([]),
      );
    }
    f.at(61_000);
    if (condition !== 'поколение') await until(() => expect(windows(f)[0]?.state).toBe('skipped'));
    expect(greetings(f)).toEqual([]);
  } finally {
    await f.close();
  }
});

test.each(['место', 'удаление'] as const)(
  'проверка перед сетевой отправкой отменяет приветствие для условия «%s»',
  async (reason) => {
    const f = await fixture({ hold: true, limit: 1, greetings: { members: [73] } });
    try {
      await enable(f);
      f.at(1_000);
      f.setMembers([73, 101]);
      join(f, 101);
      await waitWindows(f, 1);
      f.at(31_000);
      await until(() => expect(f.holds).toHaveLength(1));
      if (reason === 'место') startResponse(f.db, f.scope, 'synthetic-ordinary', f.start + 31_000);
      else {
        const privacy = personalDataStore(f.storage);
        const request = privacy.requestDeletion(f.scope, 'vk:101', 'erase', f.start + 31_000);
        expect(privacy.confirmDeletion(f.scope, 'vk:101', request.code, f.start + 31_000)).toBe(
          true,
        );
      }
      f.holds[0]!.release();
      await until(() => expect(windows(f)[0]?.state).toBe('skipped'));
      expect(greetings(f)).toEqual([]);
    } finally {
      await f.close();
    }
  },
);

test('неизвестный исход VK хранится после перезапуска с тем же идентификатором', async () => {
  const f = await fixture({ greetings: { members: [73] } });
  try {
    await enable(f);
    f.at(1_000);
    f.setMembers([73, 101]);
    const event = join(f, 101);
    await waitWindows(f, 1);
    f.failSend((text) => (text.startsWith('Привет,') ? 'unknownAfterDelivery' : undefined));
    f.at(31_000);
    await until(() => expect(windows(f)[0]?.state).toBe('unknown'));
    const [record] = windows(f);
    expect(greetings(f)).toHaveLength(1);
    expect(greetings(f)[0]?.sendId).toBe(record?.sendId);
    expect(record?.messageId).toBeNull();
    await f.restart();
    f.replay(event);
    f.at(91_000);
    expect(windows(f)).toEqual([record]);
    expect(greetings(f)).toHaveLength(1);
  } finally {
    await f.close();
  }
});
