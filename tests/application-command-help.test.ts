import { expect, test } from 'vitest';
import { fixture, peer, until } from './helpers/application-response-fixture';

test('помощь и команды совпадают и учитывают права, канал и режим', async () => {
  const app = await fixture({ greetings: { members: [41, 42, 73] } });
  try {
    app.at(1000);
    async function request(text: string, from: number, has: string, destination = peer) {
      const start = app.sends.length;
      app.submit(text, from, undefined, destination);
      await until(() =>
        expect(
          app.sends.slice(start).some((s) => s.peer_id === destination && s.text.includes(has)),
          `${destination} от ${from}, ${text} → ${has}; получено: ${app.sends
            .slice(start)
            .map((row) => row.text)
            .join(' | ')}`,
        ).toBe(true),
      );
      return app.sends.slice(start).find((s) => s.peer_id === destination && s.text.includes(has))!
        .text;
    }
    const member = await request('/помощь', 41, 'Доступные команды');
    expect(await request('/команды', 41, 'Доступные команды')).toBe(member);
    expect(member).toContain('/анкета удалить');
    expect(member).not.toMatch(
      /\/режим|\/анкета (?:открыть|закрыть|доступ)|Приостановленные беседы/u,
    );
    await request('/анкета показать', 41, 'Анкета');
    await app.storage.authorization.transaction(app.scope, (tx) =>
      tx.grant({ userId: 'vk:42', basis: 'explicit', grantedAt: app.start, grantedBy: 'vk:73' }),
    );
    const admin = await request('/команды', 42, 'Доступные команды');
    expect(admin).toContain('/режим');
    await request('/режим', 42, '/режим активный');
    await request('/режим молчаливый', 42, 'молчаливый');
    expect(await request('/помощь', 42, 'Доступные команды')).not.toContain('/анкета изменить');
    const start = app.sends.length;
    await app.journaled(app.submit('/помощь', 41));
    await request('/настройки', 42, 'молчаливый');
    expect(app.sends.slice(start).filter((x) => x.text.startsWith('Доступные команды'))).toEqual(
      [],
    );
    const owner = await request('/помощь', 73, 'Приостановленные беседы', 73);
    expect(await request('/команды', 73, 'Приостановленные беседы', 73)).toBe(owner);
    await request('Приостановленные беседы', 73, 'бесед', 73);
    expect(app.complete).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
