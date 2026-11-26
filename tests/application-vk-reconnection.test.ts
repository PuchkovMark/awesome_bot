import { expect, test } from 'vitest';
import {
  answer,
  chat,
  fixture,
  mention,
  peer,
  until,
} from './helpers/application-response-fixture';
import { lifecycleBackend } from '../src/storage/lifecycle-store';

test('ночь пустых опросов и повтор страницы сохраняют одну запись и один ответ в личке и группе', async () => {
  const app = await fixture({ active: true });
  try {
    const personal = app.submit('Первый вопрос', 41, undefined, 41);
    await app.published(personal);
    const scope = lifecycleBackend(app.storage).current(chat);
    await app.emptyPoll();
    app.at(8 * 60 * 60 * 1000);
    await app.emptyPoll();
    await app.transportRetry();
    for (const [destination, question] of [
      [peer, mention],
      [41, 'Утренний вопрос'],
    ] as const) {
      const id = app.submit(question, 41, undefined, destination);
      app.replay(id, destination);
      await app.published(id);
      expect(
        app.sends.filter((row) => row.reply_message?.conversation_message_id === id),
      ).toHaveLength(1);
      expect(
        app.db
          .prepare('SELECT count(*) FROM messages WHERE chat_id=? AND platform_message_id=?')
          .pluck()
          .get(`vk:${destination}`, String(id)),
      ).toBe(1);
    }
    expect(lifecycleBackend(app.storage).current(chat).generation).toBe(scope.generation);
  } finally {
    await app.close();
  }
});

test('первый вопрос владельца и участника после обрыва и перезапуска проходит однажды в прежней личке', async () => {
  const app = await fixture({ userRequests: 100, limit: 50 });
  try {
    for (const actor of [41, 73])
      await app.published(app.submit('До перерыва', actor, undefined, actor));
    const connections = app.db.prepare(
      "SELECT chat_id,generation FROM chat_connections WHERE chat_id IN ('vk:41','vk:73') ORDER BY chat_id",
    );
    const before = connections.all();
    for (const gap of [() => app.loseObservation(), () => app.restart()]) {
      await gap();
      for (const actor of [41, 73]) {
        const id = app.submit('После перерыва', actor, undefined, actor);
        app.replay(id, actor);
        await app.published(id);
        expect(
          app.sends.filter((row) => row.reply_message?.conversation_message_id === id),
        ).toHaveLength(1);
        const scope = lifecycleBackend(app.storage).current(`vk:${actor}`);
        expect(
          (await app.storage.messages.list(scope, { limit: 30 })).some(
            (row) => row.text === 'До перерыва',
          ),
        ).toBe(true);
      }
    }
    expect(connections.all()).toEqual(before);
    expect(app.complete).toHaveBeenCalledTimes(6);
  } finally {
    await app.close();
  }
});

test('после пропуска группа отвечает только по свежей истории, повторяет сверку прав и сохраняет первичный допуск', async () => {
  const app = await fixture({ active: true, administrationIntervalMs: 20 });
  try {
    const other = peer + 1,
      unknown = peer + 2;
    await app.connectGroup(other);
    const old = app.submit(mention + ' про секретный маркер до разрыва');
    await app.published(old);
    await app.loseObservation();
    app.setGroupAllowed(other, false);
    await app.emptyPoll();
    const fresh = app.submit(mention);
    await app.published(fresh);
    const after = lifecycleBackend(app.storage).current(chat);
    expect(
      (await app.storage.messages.list(after, { limit: 25 })).some(
        (row) => row.messageId === String(old),
      ),
    ).toBe(false);
    expect(
      app.db
        .prepare('SELECT text FROM messages WHERE chat_id=? AND platform_message_id=?')
        .pluck()
        .get(chat, String(old)),
    ).toContain('секретный маркер');
    expect(JSON.stringify(app.complete.mock.calls.at(-1)?.[0].messages)).not.toContain(
      'секретный маркер',
    );
    app.submit(mention, 41, undefined, unknown);
    const state = app.db.prepare('SELECT state FROM chat_connections WHERE chat_id=?').pluck();
    await until(() => expect(state.get(`vk:${unknown}`)).toBe('uncertain'));
    expect(state.get(`vk:${other}`)).toBe('uncertain');
    app.setGroupAllowed(other, true);
    app.at(31_000);
    await until(() => expect(state.get(`vk:${other}`)).toBe('active'));
    const second = app.submit(mention, 41, undefined, other);
    await app.published(second);
    expect(app.sends.filter((row) => row.peer_id === unknown)).toEqual([]);
  } finally {
    await app.close();
  }
});

test('выключение владельцем во время сверки отменяет допуск, публикацию и повтор старого входа', async () => {
  const app = await fixture();
  try {
    const initial = app.submit(mention);
    await app.published(initial);
    await app.loseObservation();
    const held = app.holdRequest(
      (method, args) =>
        method === 'messages.getConversationsById' && String(args.peer_ids) === String(peer),
    );
    const fresh = app.submit(mention);
    await held.entered;
    app.submit(`/выключить-бота ${chat}@${app.scope.generation}`, 73, undefined, 73);
    await until(() =>
      expect(app.db.prepare('SELECT enabled FROM chats WHERE chat_id=?').pluck().get(chat)).toBe(0),
    );
    held.release();
    await app.restart();
    app.replay(fresh);
    await app.emptyPoll();
    expect(app.db.prepare('SELECT enabled FROM chats WHERE chat_id=?').pluck().get(chat)).toBe(0);
    expect(
      app.db
        .prepare('SELECT id FROM messages WHERE chat_id=? AND platform_message_id=?')
        .get(chat, String(fresh)),
    ).toBeUndefined();
    expect(app.complete).toHaveBeenCalledOnce();
  } finally {
    await app.close();
  }
});

test('подтверждённые VK выход и новое приглашение отделяют прежнее поколение группы', async () => {
  const app = await fixture();
  try {
    const id = app.submit(mention);
    await app.published(id);
    const departure = app.membership('chat_kick_user', 73, -314);
    const arrival = app.membership('chat_invite_user', 73, -314);
    const get = () =>
      app.db
        .prepare('SELECT generation,state,pause_reason FROM chat_connections WHERE chat_id=?')
        .get(chat);
    await until(() =>
      expect(get()).toMatchObject({ state: 'uncertain', pause_reason: 'first_seen' }),
    );
    const next = get();
    expect(next).not.toMatchObject({ generation: app.scope.generation });
    expect(
      app.db
        .prepare('SELECT id FROM messages WHERE chat_id=? AND platform_message_id=?')
        .get(chat, String(id)),
    ).toBeUndefined();
    app.replay(departure, peer);
    app.replay(arrival, peer);
    await app.emptyPoll();
    expect(get()).toEqual(next);
  } finally {
    await app.close();
  }
});

test('выключенная владельцем личка остаётся закрытой после перезапуска и допускает служебное включение', async () => {
  const app = await fixture();
  try {
    for (const actor of [41, 73])
      await app.published(app.submit('Привет', actor, undefined, actor));
    const controls = app.db.prepare('SELECT enabled FROM chats WHERE chat_id=?').pluck();
    for (const actor of [41, 73]) {
      const target = lifecycleBackend(app.storage).current(`vk:${actor}`);
      app.submit(`/выключить-бота ${target.chatId}@${target.generation}`, 73, undefined, 73);
      await until(() => expect(controls.get(target.chatId)).toBe(0));
    }
    await app.restart();
    const previous = app.complete.mock.calls.length;
    for (const actor of [41, 73]) {
      const target = `vk:${actor}`;
      const generation = app.db
        .prepare('SELECT generation FROM chat_connections WHERE chat_id=?')
        .pluck()
        .get(target);
      const ignored = app.submit('При выключенном боте', actor, undefined, actor);
      app.replay(ignored, actor);
      app.submit(`/включить-бота ${target}@${generation}`, 73, undefined, 73);
      await until(() => expect(controls.get(target)).toBe(1));
      expect(
        app.db
          .prepare('SELECT id FROM messages WHERE text=? AND chat_id=?')
          .get('При выключенном боте', target),
      ).toBeUndefined();
      await app.published(app.submit('После включения', actor, undefined, actor));
    }
    expect(app.complete).toHaveBeenCalledTimes(previous + 2);
    expect(app.sends.some((row) => row.text === answer.text)).toBe(true);
  } finally {
    await app.close();
  }
});
