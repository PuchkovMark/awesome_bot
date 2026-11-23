import { expect, test } from 'vitest';
import type { ConnectionScope } from '../src/contracts/index';
import { createAuthorizationService } from '../src/core/index';
import { profileInference } from '../src/storage/profile-fact-store';
import { inferenceFreshnessMs } from '../src/storage/profile-fact-selection';
import { lifecycleBackend } from '../src/storage/lifecycle-store';
import { participantRegistryStore } from '../src/storage/participant-registry';
import type { ProfileFactChange } from '../src/storage/participant-types';
import {
  answer,
  chat,
  fixture,
  mention,
  peer,
  until,
} from './helpers/application-response-fixture';
import { authConfig } from './helpers/authorization-fixture';

const notice = 'Профиль используется в беседе.';
const author = 'vk:41';
const updated = 'Профиль обновлён.';
const retry = 'Откройте /профиль заново';
const hint = 'Откройте личный диалог с сообществом';
type App = Awaited<ReturnType<typeof fixture>>;

async function seed(app: App, scope: ConnectionScope, ...changes: ProfileFactChange[]) {
  const auth = await createAuthorizationService({
    config: authConfig,
    store: app.storage.authorization,
  });
  try {
    const { id } = await app.storage.messages.append(scope, {
      chatId: scope.chatId,
      userId: author,
      messageId: '999999',
      role: 'user',
      text: 'Синтетическая исходная реплика.',
      authorName: 'Саша Иванов',
      senderBot: false,
      timestamp: Date.now(),
    });
    for (const change of changes)
      expect(
        await auth.changeProfileFact(auth.context({ scope, userId: author }), {
          subjectId: author,
          messageId: id,
          change,
        }),
      ).toMatchObject({ allowed: true, value: 'recorded' });
  } finally {
    auth.dispose();
  }
}

const item = (fieldKey: string, value: string) => ({
  kind: 'set' as const,
  fieldKey,
  value,
  reliability: 'unverified' as const,
});

function profile(app: App, start = 0, destination = 41) {
  return app.sends
    .slice(start)
    .find((row) => row.peer_id === destination && row.text.startsWith('Профиль в'));
}

async function receivedPart(app: App, start = 0) {
  await until(() => {
    expect(profile(app, start)).toBeDefined();
    expect(
      app.db
        .prepare('SELECT count(*) FROM profile_command_parts WHERE receipt=?')
        .pluck()
        .get(String(profile(app, start)!.conversation_message_id)),
    ).toBe(1);
  });
  return profile(app, start)!;
}

test('профиль выбранной беседы, пустая личка и нейтральный отказ доставки', async () => {
  const app = await fixture({ profileNotice: notice });
  try {
    app.at(2000);
    await seed(app, app.scope, item('private_field', 'Секретный маркер'), {
      kind: 'visibility',
      fieldKey: 'private_field',
      visibility: 'bot',
    });
    app.name(41, 'Саша', 'Иванов');
    app.name(42, 'Саша', 'Иванов');
    app.submit('/профиль');
    const groupList = await receivedPart(app);
    expect(groupList.text).toContain('Секретный маркер');
    expect(groupList.text).toContain('скрыто от беседы');

    let start = app.sends.length;
    app.submit('/профиль', 41, undefined, 41);
    expect((await receivedPart(app, start)).text).toContain('пока нет доступных фактов');
    app.at(3000);
    const dm = lifecycleBackend(app.storage).current(author);
    await seed(app, dm, item('city', 'Личный город'));
    start = app.sends.length;
    app.submit('/профиль', 41, undefined, 41);
    expect((await receivedPart(app, start)).text).toContain('Личный город');

    start = app.sends.length;
    app.submit('/профиль ' + chat, 41, undefined, 41);
    const directList = await receivedPart(app, start);
    expect(directList.text).toContain('Секретный маркер');

    app.submit('/скрыть 1', 42, directList, 42, true);
    app.submit('/скрыть 1', 42, directList, 42);
    await until(() =>
      expect(app.sends.some((row) => row.peer_id === 42 && row.text.startsWith(retry))).toBe(true),
    );
    expect(
      app.sends.some((row) => row.peer_id === 42 && row.text.includes('Секретный маркер')),
    ).toBe(false);

    app.setPrivateAllowed(false);
    app.submit('/профиль');
    await until(() =>
      expect(app.sends.some((row) => row.peer_id === peer && row.text.startsWith(hint))).toBe(true),
    );
    const publicText = app.sends
      .filter((row) => row.peer_id === peer)
      .map((row) => row.text)
      .join(' ');
    expect(publicText).not.toMatch(/Секретный маркер|private_field|Личный город/u);
    expect(app.complete).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

test('для длинной позиции нужны подтверждения всех частей, а данные правки не попадают в журнал и модель', async () => {
  const app = await fixture({ profileNotice: notice });
  try {
    app.at(2000);
    await seed(app, app.scope, item('city', 'строка\n2. поддельная позиция '.repeat(160).trim()));
    app.failSend((text) =>
      text.includes('Позиция 1, продолжение.') ? 'unknownAfterDelivery' : undefined,
    );
    app.submit('/профиль');
    const first = await receivedPart(app);
    expect(first.text).toContain('/исправить N значение');
    expect(first.text).not.toMatch(/\n2\. поддельная/u);
    await until(() =>
      expect(app.sends.some((row) => row.text.includes('Позиция 1, продолжение.'))).toBe(true),
    );
    const unconfirmed = app.sends.find((row) => row.text.includes('Позиция 1, продолжение.'))!;
    expect(
      app.db
        .prepare('SELECT count(*) FROM profile_command_parts WHERE receipt IS NULL')
        .pluck()
        .get(),
    ).toBeGreaterThan(0);

    const before = app.sends.length;
    for (const part of [first, unconfirmed]) {
      app.submit('/исправить 1 ЧУЖАЯПОПЫТКА', 41, part, 41);
    }
    await until(() =>
      expect(app.sends.slice(before).filter((row) => row.text.startsWith(retry))).toHaveLength(2),
    );
    app.failSend(undefined);
    const opened = app.sends.length;
    app.submit('/профиль ' + chat, 41, undefined, 41);
    const current = await receivedPart(app, opened);
    await until(() =>
      expect(
        app.db
          .prepare('SELECT count(*) FROM profile_command_parts WHERE receipt IS NULL')
          .pluck()
          .get(),
      ).toBe(0),
    );
    expect(
      app.sends.slice(opened).filter((row) => row.text.startsWith('Профиль в')).length,
    ).toBeGreaterThan(1);
    expect(app.sends.slice(opened).every((row) => Buffer.byteLength(row.text) <= 4000)).toBe(true);

    app.submit('/исправить 1 ЛИЧНОЕИСПРАВЛЕНИЕ', 41, current, 41);
    await until(() => expect(app.sends.some((row) => row.text === updated)).toBe(true));
    const wrong = app.submit('/исправить 99 МАРКЕРОШИБКИ');
    await app.journaled(wrong);
    const journal = app.db
      .prepare('SELECT text,purpose FROM messages WHERE chat_id=? AND platform_message_id=?')
      .get(chat, String(wrong));
    expect(journal).toEqual({ text: 'Личная команда профиля', purpose: 'service_notice' });
    for (const marker of ['ЧУЖАЯПОПЫТКА', 'ЛИЧНОЕИСПРАВЛЕНИЕ', 'МАРКЕРОШИБКИ']) {
      expect(
        app.db.prepare('SELECT count(*) FROM messages WHERE instr(text,?)>0').pluck().get(marker),
      ).toBe(0);
      expect(
        app.db
          .prepare('SELECT count(*) FROM messages_fts WHERE messages_fts MATCH ?')
          .pluck()
          .get(marker),
      ).toBe(0);
    }
    expect(app.complete).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

test('личное скрытие сразу исключает интерес из поиска и прерывает готовящийся публичный ответ', async () => {
  const app = await fixture({ profileNotice: notice });
  const wait = Promise.withResolvers<void>();
  try {
    app.at(2000);
    participantRegistryStore(app.storage).observe(app.scope, {
      kind: 'membership',
      chatId: chat,
      change: 'joined',
      timestamp: Date.now(),
      subjectId: author,
      actorId: author,
      eventId: 'join-046',
    });
    await seed(app, app.scope, item('interest', 'Гончарное дело'));
    expect(
      app.storage.profileFacts.searchInterests(app.scope, 'гончарное дело').matches,
    ).toHaveLength(1);
    app.submit('/профиль');
    const list = await receivedPart(app);
    app.complete
      .mockResolvedValueOnce({
        kind: 'tool_calls',
        calls: [
          { name: 'participant_search', id: 'find', arguments: '{"query":"гончарное дело"}' },
        ],
        usage: { input: 31, output: 7 },
        text: null,
      })
      .mockImplementation(async (request) => {
        const toolResult = request.messages.find((message) => message.role === 'tool');
        expect(JSON.parse(toolResult!.text).participants).toHaveLength(1);
        await wait.promise;
        return answer;
      });
    const input = app.submit(mention + ' Кто увлекается гончарным делом?', 73);
    await until(() => expect(app.complete).toHaveBeenCalledTimes(2));
    app.submit('/скрыть 1', 41, list, 41);
    await until(() => expect(app.sends.some((row) => row.text === updated)).toBe(true));
    expect(app.storage.profileFacts.searchInterests(app.scope, 'гончарное дело').matches).toEqual(
      [],
    );
    wait.resolve();
    await app.interrupted(input);
    expect(app.sends.some((row) => row.peer_id === peer)).toBe(false);
  } finally {
    wait.resolve();
    await app.close();
  }
});

test('личный список показывает происхождение, UTC-дату свидетельства и старение вывода', async () => {
  const app = await fixture({
    profileNotice: notice,
    retentionDays: 120,
    greetings: { members: [41] },
  });
  try {
    app.at(2000);
    const at = Date.now();
    const { id } = await app.storage.messages.append(app.scope, {
      chatId: chat,
      userId: author,
      messageId: '999998',
      role: 'user',
      text: 'Я люблю шахматы.',
      senderBot: false,
      authorName: 'Саша Иванов',
      timestamp: at,
    });
    expect(
      profileInference(app.storage)(app.scope, {
        subjectId: author,
        messageId: id,
        change: item('interest', 'Шахматы'),
      }),
    ).toBe('recorded');
    app.at(2000 + inferenceFreshnessMs - 1);
    app.submit('/профиль');
    const first = await receivedPart(app);
    expect(first.text).toContain('вывод бота');
    expect(first.text).toContain('свидетельство от 2026-11-23 UTC');
    expect(first.text).not.toContain('устарело');
    const start = app.sends.length;
    app.at(2000 + inferenceFreshnessMs);
    app.submit('/профиль');
    expect((await receivedPart(app, start)).text).toContain('устарело');
  } finally {
    await app.close();
  }
});
