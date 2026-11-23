import { expect, test, vi } from 'vitest';
import { fixture, chat, until, mention, answer } from './helpers/application-response-fixture';

test('в группе файл получает только автор, подтверждение из чужой лички не удаляет историю', async () => {
  const upload = vi.fn<(peer: number, data: Buffer) => Promise<string>>();
  let copied = '';
  upload.mockImplementation(async (_, data) => {
    copied = data.toString();
    return 'doc1_2';
  });
  const app = await fixture({ profileNotice: 'Синтетическое уведомление профиля', upload });
  try {
    const own = app.submit('факт автора', 41),
      foreign = app.submit('посторонний текст', 42);
    await app.journaled(own);
    await app.journaled(foreign);
    app.submit('/мои-данные', 41);
    await until(() => expect(app.filesSent).toEqual([{ peer: 41, attachment: 'doc1_2' }]));
    expect(JSON.parse(copied)).toMatchObject({ chat, user: 'vk:41' });
    expect(copied).toContain('факт автора');
    expect(copied).not.toContain('посторонний текст');
    const model = Promise.withResolvers<typeof answer>();
    app.complete.mockImplementationOnce(() => model.promise);
    app.submit(mention, 41);
    await until(() => expect(app.complete).toHaveBeenCalled());
    app.submit('/удалить-мои-данные', 41);
    await until(() =>
      expect(
        app.sends.some((x) => x.peer_id === 41 && x.text.includes('/подтверждаю-удаление')),
      ).toBe(true),
    );
    const command = app.sends
      .find((x) => x.text.includes('/подтверждаю-удаление'))!
      .text.match(/\/подтверждаю-удаление [a-f0-9]+/u)![0];
    app.submit(command, 42, undefined, 42);
    await until(() =>
      expect(
        app.sends.some((x) => x.peer_id === 42 && x.text.includes('Синтетическое уведомление')),
      ).toBe(true),
    );
    expect(
      await app.storage.contextMessages.search(app.scope, 'факт автора', 10, 100),
    ).toHaveLength(1);
    app.submit(command, 41, undefined, 41);
    await until(() =>
      expect(app.sends.some((x) => x.peer_id === 41 && x.text.startsWith('Удаление принято'))).toBe(
        true,
      ),
    );
    model.resolve(answer);
    await until(async () =>
      expect(await app.storage.contextMessages.search(app.scope, 'факт автора', 10, 100)).toEqual(
        [],
      ),
    );
    expect(app.sends.some((x) => x.text === answer.text)).toBe(false);
    expect(
      await app.storage.contextMessages.search(app.scope, 'посторонний текст', 10, 100),
    ).toHaveLength(1);
  } finally {
    await app.close();
  }
});

test('удаление во время загрузки JSON отменяет отправку вложения', async () => {
  const uploaded = Promise.withResolvers<string>();
  const upload = vi.fn(() => uploaded.promise);
  const app = await fixture({ profileNotice: 'Синтетическое уведомление профиля', upload });
  try {
    const id = app.submit('личный текст');
    await app.journaled(id);
    app.submit('/мои-данные');
    await until(() => expect(upload).toHaveBeenCalledTimes(1));
    app.submit('/удалить-мои-данные ' + chat, 41, undefined, 41);
    await until(() =>
      expect(app.sends.some((x) => x.text.includes('/подтверждаю-удаление'))).toBe(true),
    );
    const command = app.sends
      .find((x) => x.text.includes('/подтверждаю-удаление'))!
      .text.match(/\/подтверждаю-удаление [a-f0-9]+/u)![0];
    app.submit(command, 41, undefined, 41);
    await until(() =>
      expect(app.sends.some((x) => x.text.startsWith('Удаление принято'))).toBe(true),
    );
    uploaded.resolve('doc1_2');
    await until(() => expect(app.sends.some((x) => x.text.includes('не подтверждена'))).toBe(true));
    expect(app.filesSent).toEqual([]);
  } finally {
    uploaded.resolve('doc1_2');
    await app.close();
  }
});

test('владелец меняет условия, отказ сохраняется, в группе нет личной рассылки', async () => {
  const app = await fixture({ profileNotice: 'Профиль тестовый' });
  try {
    app.submit('обычная фраза', 41);
    app.submit('/отключить-профиль', 41);
    await until(() =>
      expect(app.sends.some((x) => x.peer_id === 41 && x.text.includes('отключено'))).toBe(true),
    );
    expect(app.sends.filter((x) => x.text.includes('Профиль тестовый'))).toHaveLength(0);
    app.submit('/текст-уведомления попытка', 41, undefined, 41);
    await until(() =>
      expect(app.sends.some((x) => x.peer_id === 41 && x.text.includes('Профиль тестовый'))).toBe(
        true,
      ),
    );
    app.submit('/текст-уведомления новая версия', 73, undefined, 73);
    await until(() =>
      expect(app.sends.some((x) => x.peer_id === 73 && x.text.startsWith('Сохранена версия'))).toBe(
        true,
      ),
    );
    expect(
      app.db
        .prepare('SELECT profile_notice FROM disclosure_versions ORDER BY version')
        .pluck()
        .all(),
    ).toEqual(['Профиль тестовый', 'новая версия']);
    expect(app.db.prepare('SELECT user_id FROM personal_profile_choices').pluck().all()).toEqual([
      'vk:41',
    ]);
    expect(
      app.sends.filter((x) => x.peer_id === 41 && x.text.includes('Профиль тестовый')),
    ).toHaveLength(1);
  } finally {
    await app.close();
  }
});
