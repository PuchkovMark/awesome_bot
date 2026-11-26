import { expect, test, vi } from 'vitest';
import { personalDataStore } from '../src/storage/personal-data-store';
import {
  fixture,
  chat,
  peer,
  until,
  mention,
  answer,
} from './helpers/application-response-fixture';

async function askInPrivate(
  app: Awaited<ReturnType<typeof fixture>>,
  author: number,
  command: string,
) {
  const before = app.sends.length;
  app.submit(command, author, undefined, author);
  const replies = () => app.sends.slice(before).filter((sent) => sent.peer_id === author);
  await until(() => expect(replies()).toHaveLength(1));
  return replies()[0]!.text;
}

function confirmationCommand(text: string) {
  const command = text.match(/\/подтверждаю-удаление [a-f0-9]{24}/u);
  expect(command).not.toBeNull();
  return command![0];
}

test('после истечения и повтора кода автор может продолжить удаление в выбранной беседе', async () => {
  const app = await fixture({ active: true });
  try {
    const neighbor = await app.connectGroup(peer + 1);
    const source = 'Материалы к встрече';
    const visible = async (scope: typeof app.scope) =>
      (await app.storage.messages.list(scope, { limit: 100 })).some((row) => row.text === source);
    const confirmations = () =>
      app.db
        .prepare(
          'SELECT confirmed_at FROM personal_deletions WHERE chat_id=? AND user_id=? ORDER BY rowid',
        )
        .pluck()
        .all(chat, 'vk:41');
    await app.journaled(app.submit(source));
    app.submit(source, 41, undefined, peer + 1);
    await until(async () => expect(await visible(neighbor)).toBe(true));

    const first = confirmationCommand(await askInPrivate(app, 41, '/удалить-мои-данные ' + chat));
    app.at(15 * 60_000);
    const expired = await askInPrivate(app, 41, first);
    const commands = expired.split('\n').filter((line) => line.startsWith('/'));
    expect(commands).toEqual(['/статус-удаления ' + chat, '/удалить-мои-данные ' + chat]);
    expect(await askInPrivate(app, 41, commands[0]!)).toBe('Подтверждённого удаления пока нет.');
    expect(confirmations()).toEqual([null]);

    const renewed = confirmationCommand(await askInPrivate(app, 41, commands[1]!));
    expect(renewed).not.toBe(first);
    expect(confirmations()).toEqual([null, null]);
    expect(await visible(app.scope)).toBe(true);
    expect(await visible(neighbor)).toBe(true);
    expect(await askInPrivate(app, 41, renewed)).toContain('Удаление принято.');

    const used = await askInPrivate(app, 41, renewed);
    const usedCommands = used.split('\n').filter((line) => line.startsWith('/'));
    expect(usedCommands).toEqual(commands);
    expect(await askInPrivate(app, 41, usedCommands[0]!)).toBe(
      personalDataStore(app.storage).status(app.scope, 'vk:41', Date.now()),
    );
    expect(confirmations()).toEqual([app.start + 15 * 60_000]);
    expect(await visible(app.scope)).toBe(false);
    expect(await visible(neighbor)).toBe(true);
  } finally {
    await app.close();
  }
});

test('неизвестный код, чужой код и недоступная беседа дают одинаковую личную подсказку', async () => {
  const app = await fixture();
  try {
    await app.journaled(app.submit('Запись первого автора', 41));
    await app.journaled(app.submit('Запись второго автора', 42));
    const request = '/удалить-мои-данные ' + chat;
    const own = confirmationCommand(await askInPrivate(app, 41, request));
    const foreign = confirmationCommand(await askInPrivate(app, 42, request));
    const confirmations = () =>
      app.db.prepare('SELECT confirmed_at FROM personal_deletions').pluck().all();

    const before = app.sends.length;
    const unknown = await askInPrivate(app, 41, '/подтверждаю-удаление ' + '0'.repeat(24));
    expect(unknown).toContain('/статус-удаления');
    expect(unknown).toContain('/удалить-мои-данные');
    expect(unknown).toContain('беседе');
    expect(unknown).not.toMatch(/vk:\d+|[a-f0-9]{24}|Запись (первого|второго)|Удаление принято/u);
    expect(await askInPrivate(app, 41, foreign)).toBe(unknown);
    expect(confirmations()).toEqual([null, null]);
    const visible = await app.storage.messages.list(app.scope, { limit: 100 });
    expect(visible.map((row) => row.text)).toEqual(
      expect.arrayContaining(['Запись первого автора', 'Запись второго автора']),
    );

    app.setGroupAllowed(peer, false);
    await app.loseObservation();
    expect(await askInPrivate(app, 41, own)).toBe(unknown);
    expect(confirmations()).toEqual([null, null]);
    expect(app.sends.slice(before).map((sent) => sent.peer_id)).toEqual([41, 41, 41]);
  } finally {
    await app.close();
  }
});

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
    await until(() =>
      expect(app.sends.at(-1)).toMatchObject({
        peer_id: peer,
        text: 'Разрешите сообщения сообщества и отправьте в личку /мои-данные ' + chat,
      }),
    );
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

test('явный ID соседней беседы даёт только команду для лички', async () => {
  const app = await fixture({ profileNotice: 'Уведомление о профиле' });
  try {
    const neighbor = peer + 1;
    await app.connectGroup(neighbor);
    await app.journaled(app.submit('Моя запись.'));
    for (const name of [
      'мои-данные',
      'отключить-профиль',
      'удалить-мои-данные',
      'статус-удаления',
    ]) {
      const command = `/${name} vk:${neighbor}`;
      app.submit(command);
      await until(() =>
        expect(app.sends.some((row) => row.peer_id === peer && row.text.endsWith(command))).toBe(
          true,
        ),
      );
    }
    expect(app.filesSent).toHaveLength(0);
    for (const table of ['personal_profile_choices', 'personal_deletions', 'personal_exports']) {
      expect(
        app.db
          .prepare('SELECT count(*) FROM ' + table)
          .pluck()
          .get(),
      ).toBe(0);
    }
  } finally {
    await app.close();
  }
});

test.each(['закрыта', 'потеряна квитанция'])(
  'статус и файл исходной беседы доступны по подсказке, если личка %s',
  async (fault) => {
    let loseReceipt = fault === 'потеряна квитанция';
    let exported = '';
    const app = await fixture({
      loseFileReceipt: () => loseReceipt,
      upload: async (_, data) => {
        exported = data.toString();
        return 'doc1_2';
      },
    });
    try {
      const author = 'vk:41';
      const privacy = personalDataStore(app.storage);
      const neighbor = await app.connectGroup(peer + 1);
      await app.storage.messages.append(neighbor, {
        chatId: neighbor.chatId,
        messageId: 'other',
        userId: author,
        authorName: 'Участник',
        role: 'user',
        text: 'Запись из соседней беседы',
        timestamp: app.start,
      });
      await app.journaled(app.submit('Прошлая запись автора'));
      const deletion = privacy.requestDeletion(app.scope, author, 'past-deletion', app.start);
      expect(privacy.confirmDeletion(app.scope, author, deletion.code, app.start)).toBe(true);
      privacy.cleanup(app.start);
      app.at(1000);
      await app.journaled(app.submit('Новая запись в исходной беседе'));
      const status = privacy.status(app.scope, author, app.start);
      expect(status).toContain('Очистка рабочей базы проверена.');
      expect(status).not.toBe(privacy.status(neighbor, author, app.start));

      if (loseReceipt)
        app.failSend((text) => (text === status ? 'unknownAfterDelivery' : undefined));
      else app.setPrivateAllowed(false);
      const before = app.sends.length;
      const groupReplies = () =>
        app.sends
          .slice(before)
          .filter((row) => row.peer_id === peer)
          .map((row) => row.text);
      const guide = 'Разрешите сообщения сообщества и отправьте в личку ';
      const copied: string[] = [];
      for (const name of ['/статус-удаления', '/мои-данные']) {
        const event = app.submit(name);
        await until(() => expect(groupReplies().at(-1)).toBe(guide + name + ' ' + chat));
        copied.push(groupReplies().at(-1)!.slice(guide.length));
        if (name === '/мои-данные') app.replay(event);
      }
      const filesBefore = loseReceipt ? 1 : 0;
      expect(app.filesSent).toHaveLength(filesBefore);
      loseReceipt = false;
      app.failSend(undefined);
      app.setPrivateAllowed(true);
      const next = app.sends.length;
      for (const command of copied) app.submit(command, 41, undefined, 41);
      await until(() => {
        expect(app.sends.slice(next).some((row) => row.peer_id === 41 && row.text === status)).toBe(
          true,
        );
        expect(app.filesSent).toHaveLength(filesBefore + 1);
      });
      expect(JSON.parse(exported)).toMatchObject({ chat, user: author });
      expect(exported).toContain('Новая запись в исходной беседе');
      expect(exported).not.toContain('Запись из соседней беседы');

      const success = app.sends.length;
      app.submit('/статус-удаления');
      app.submit('/мои-данные');
      await until(() => {
        expect(
          app.sends.slice(success).some((row) => row.peer_id === 41 && row.text === status),
        ).toBe(true);
        expect(app.filesSent).toHaveLength(filesBefore + 2);
      });
      expect(groupReplies()).toEqual(copied.map((command) => guide + command));
      expect(app.filesSent.every((file) => file.peer === 41)).toBe(true);
    } finally {
      await app.close();
    }
  },
);

test.each(['закрыта', 'потеряна квитанция'])(
  'из беседы можно продолжить в личке, когда она %s',
  async (fault) => {
    const app = await fixture({ profileNotice: 'Уведомление' });
    try {
      await app.journaled(app.submit('Запись автора'));
      if (fault === 'закрыта') app.setPrivateAllowed(false);
      else
        app.failSend((text) =>
          text.startsWith('Профилирование') || text.startsWith('Удалить анкету')
            ? 'unknownAfterDelivery'
            : undefined,
        );
      for (const name of ['отключить-профиль', 'удалить-мои-данные']) {
        app.submit('/' + name);
        await until(() =>
          expect(
            app.sends.some(
              (row) =>
                row.peer_id === peer &&
                row.text ===
                  'Разрешите сообщения сообщества и отправьте в личку /' + name + ' ' + chat,
            ),
          ).toBe(true),
        );
      }
      const selection = () =>
        app.db
          .prepare('SELECT disabled_at FROM personal_profile_choices WHERE chat_id=? AND user_id=?')
          .pluck()
          .get(chat, 'vk:41');
      const first = selection();
      expect(typeof first).toBe('number');
      expect(app.db.prepare('SELECT confirmed_at FROM personal_deletions').pluck().all()).toEqual([
        null,
      ]);
      expect(
        app.sends
          .filter((row) => row.peer_id === peer)
          .map((row) => row.text)
          .join('\n'),
      ).not.toMatch(/подтверждаю-удаление|выгрузка профиля доступна|Запись автора/iu);
      app.setPrivateAllowed(true);
      app.failSend(undefined);
      app.at(1000);
      const start = app.sends.length;
      app.submit('/отключить-профиль ' + chat, 41, undefined, 41);
      app.submit('/удалить-мои-данные ' + chat, 41, undefined, 41);
      await until(() => {
        const personal = app.sends
          .slice(start)
          .filter((row) => row.peer_id === 41)
          .map((row) => row.text);
        expect(personal.some((text) => text.startsWith('Профилирование'))).toBe(true);
        expect(personal.some((text) => text.includes('/подтверждаю-удаление'))).toBe(true);
      });
      expect(selection()).toBe(first);
    } finally {
      await app.close();
    }
  },
);

test.each(['оставить', 'удалить'])(
  'повтор двух принятых жалоб после решения «%s» и потери квитанции',
  async (decision) => {
    const app = await fixture({ profileNotice: 'Уведомление' });
    try {
      await app.journaled(app.submit('Запись заявителя'));
      const target = app.submit('Упоминание', 42);
      await app.journaled(target);
      const privacy = personalDataStore(app.storage);
      const request = privacy.requestDeletion(app.scope, 'vk:41', 'request', app.start);
      expect(privacy.confirmDeletion(app.scope, 'vk:41', request.code, app.start)).toBe(true);
      const report = '/сообщить-упоминание ' + chat + ' ' + target;
      const replies = () =>
        app.sends.filter(
          (row) => row.peer_id === 41 && row.text === 'Запрос по указанному сообщению обработан.',
        ).length;
      const first = app.submit(report, 41, undefined, 41);
      await until(() => expect(replies()).toBe(1));
      const second = app.submit(report, 41, undefined, 41);
      await until(() => expect(replies()).toBe(2));
      expect(privacy.disputed(app.scope)).toEqual([{ messageId: String(target) }]);
      app.failSend((text) => (text === 'Решение сохранено.' ? 'unknownAfterDelivery' : undefined));
      app.submit('/' + decision + '-запись ' + chat + ' ' + target, 73, undefined, 73);
      await until(() =>
        expect(
          app.sends.some((row) => row.peer_id === 73 && row.text === 'Решение сохранено.'),
        ).toBe(true),
      );
      app.failSend(undefined);
      async function checkVisibility() {
        const visible = decision === 'оставить';
        expect(
          (await app.storage.messages.list(app.scope, { limit: 100 })).some(
            (row) => row.messageId === String(target),
          ),
        ).toBe(visible);
        expect(
          await app.storage.contextMessages.search(app.scope, 'Упоминание', 5, 128),
        ).toHaveLength(visible ? 1 : 0);
        expect(privacy.disputed(app.scope)).toEqual([]);
      }
      for (const [index, event] of [first, second].entries()) {
        app.replay(event);
        await until(() => expect(replies()).toBe(3 + index));
        await checkVisibility();
      }
      privacy.cleanup(app.start);
      await checkVisibility();
      app.submit('/спорные-записи ' + chat, 73, undefined, 73);
      await until(() =>
        expect(app.sends.at(-1)).toMatchObject({ peer_id: 73, text: 'Спорных записей нет.' }),
      );
    } finally {
      await app.close();
    }
  },
);
