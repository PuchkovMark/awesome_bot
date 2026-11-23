import { expect, test } from 'vitest';
import { personaScenarios } from '../src/evals/personas';
import { lifecycleBackend } from '../src/storage/lifecycle-store';
import { fixture, mention, peer, until } from './helpers/application-response-fixture';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const library = 'Алекс, Макс, Сократ, Виктор, Никон, Чипсик';
const neighbor = peer + 1;

async function command(app: Fixture, text: string, from: number, to: number, reply: string) {
  const start = app.sends.length;
  const id = app.submit(text, from, undefined, to);
  await until(() =>
    expect(
      app.sends
        .slice(start)
        .filter(({ peer_id }) => peer_id === to)
        .map((message) => message.text),
    ).toContainEqual(expect.stringContaining(reply)),
  );
  return id;
}

async function ordinary(
  app: Fixture,
  from: number,
  to: number,
  expected: [key: string, name: string],
) {
  const id = app.submit(to === from ? 'Вопрос в личке' : mention, from, undefined, to);
  await app.published(id);
  const input = app.complete.mock.calls.at(-1)![0];
  const current = input.messages.findLast(({ role }) => role === 'user');
  expect(JSON.parse(current!.text!).persona?.name).toBe(expected[1]);
  const scope = lifecycleBackend(app.storage).current(`vk:${to}`);
  await until(async () => {
    const trace = await app.storage.traces.last(scope);
    expect(trace?.payload.publication.status).toBe('delivered');
    expect(trace?.payload.context?.persona?.version).toMatchObject({
      area: 'global',
      kind: 'persona',
      key: expected[0],
      version: 1,
    });
  });
}

test('список, разрешённый выбор и переигранное событие в двух беседах и двух личках', async () => {
  const app = await fixture({ vkAdmins: [42] });
  try {
    app.setMembers([41, 42, 43, 73]);
    const second = await app.connectGroup(neighbor);
    await app.storage.authorization.transaction(app.scope, (tx) =>
      tx.grant({ userId: 'vk:41', basis: 'explicit', grantedAt: app.start, grantedBy: 'vk:73' }),
    );
    await command(app, '/персонаж', 43, peer, library);
    expect(app.sends.at(-1)?.text).toContain('Текущий персонаж — Макс');
    await command(app, '/персонаж', 42, 42, 'Текущий персонаж — Макс');
    for (const author of [42, 43]) await app.journaled(app.submit('/персонаж Никон', author));
    await command(app, '/персонаж', 43, peer, 'Текущий персонаж — Макс');
    expect(await app.storage.versions.selected(app.scope, 'persona')).toBeNull();
    const old = await command(app, '/персонаж Алекс', 41, peer, 'отвечает Алекс');
    await command(app, '/ПЕРСОНАЖ вИкТоР', 41, peer, 'отвечает Виктор');
    app.replay(old);
    await command(app, '/персонаж кто-то', 43, peer, library);
    expect(app.sends.at(-1)?.text).toContain('Текущий персонаж — Виктор');
    const journal = await app.storage.messages.list(app.scope, { limit: 40 });
    expect(journal.filter(({ messageId }) => messageId === String(old))).toHaveLength(1);
    await command(app, '/персонаж Сократ', 41, 41, 'отвечает Сократ');
    expect(await app.storage.authorization.transaction(second, (tx) => tx.bases('vk:73'))).toEqual(
      [],
    );
    await command(app, '/персонаж Алекс', 73, neighbor, 'отвечает Алекс');
    expect(app.complete).not.toHaveBeenCalled();

    await app.restart(true, [neighbor, 41, 42]);
    await ordinary(app, 41, peer, ['victor', 'Виктор']);
    await ordinary(app, 42, peer, ['victor', 'Виктор']);
    await ordinary(app, 42, neighbor, ['alex', 'Алекс']);
    await ordinary(app, 41, 41, ['socrates', 'Сократ']);
    await ordinary(app, 42, 42, ['max', 'Макс']);
    expect(app.complete).toHaveBeenCalledTimes(5);
  } finally {
    await app.close();
  }
});

test('в молчаливой беседе доступна смена владельцем, выключение останавливает команды персонажа', async () => {
  const app = await fixture();
  try {
    await app.storage.chats.update(app.scope, { responseMode: 'silent' });
    await app.journaled(app.submit('/персонаж', 42));
    expect(app.sends).toHaveLength(0);
    await command(app, '/персонаж Никон', 73, peer, 'отвечает Никон');
    await app.storage.chats.update(app.scope, { enabled: false });
    const sent = app.sends.length;
    const disabled = app.submit('/персонаж Чипсик', 73);
    await command(app, '/персонаж', 42, 42, 'Текущий персонаж — Макс');
    expect(app.sends.slice(sent).filter(({ peer_id }) => peer_id === peer)).toEqual([]);
    expect(
      (await app.storage.messages.list(app.scope, { limit: 30 })).some(
        ({ messageId }) => messageId === String(disabled),
      ),
    ).toBe(false);
    expect(await app.storage.versions.selected(app.scope, 'persona')).toMatchObject({
      ref: { key: 'nikon', version: 1 },
    });
    const privateScope = lifecycleBackend(app.storage).current('vk:42');
    await app.storage.chats.update(privateScope, { responseMode: 'silent' });
    const privateSelection = app.submit('/персонаж Алекс', 42, undefined, 42);
    await until(async () =>
      expect(
        (await app.storage.messages.list(privateScope, { limit: 10 })).some(
          ({ messageId }) => messageId === String(privateSelection),
        ),
      ).toBe(true),
    );
    expect(await app.storage.versions.selected(privateScope, 'persona')).toBeNull();
    expect(app.complete).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

test('полная карточка Чипсика помещается со штатными правилами обращения в беседе и личке', async () => {
  const direct = personaScenarios.find(({ id }) => id === 'persona-chipsik')!;
  const group = personaScenarios.find(({ id }) => id === 'persona-boundaries')!;
  const app = await fixture({
    profileNotice: 'Тестовое уведомление о профиле.',
    modelContextTokens: 16384,
    systemPrompt: direct.prompt,
  });
  try {
    app.name(41, 'Тестовый', 'участник');
    await command(app, '/персонаж Чипсик', 41, 41, 'отвечает Чипсик');
    const privateMessage = app.submit(direct.input.text, 41, undefined, 41);
    await app.published(privateMessage);
    await command(app, '/персонаж Чипсик', 73, peer, 'отвечает Чипсик');
    const meeting = group.history[0]!.text;
    app.name(42, 'Тестовая', 'Вера');
    await app.journaled(app.submit(meeting, 42));
    const groupMessage = app.submit(`Пенёк, подскажи. ${group.input.text}`, 41);
    await app.published(groupMessage);
    expect(app.complete).toHaveBeenCalledTimes(2);
    const request = JSON.stringify(app.complete.mock.calls.at(-1)![0].messages);
    expect(request).toContain(meeting);
    expect((await app.trace(groupMessage)).payload.context?.persona?.version).toMatchObject({
      key: 'chipsik',
      version: 1,
    });
  } finally {
    await app.close();
  }
});
