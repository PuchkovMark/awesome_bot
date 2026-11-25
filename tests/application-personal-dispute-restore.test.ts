import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { resolveApplicationChat } from '../src/app/setup';
import { openStorage, type Storage } from '../src/storage/index';
import { lifecycleBackend } from '../src/storage/lifecycle-store';
import { personalDataStore } from '../src/storage/personal-data-store';
import { chat, fixture, ownerId, peer, until } from './helpers/application-response-fixture';
import { storageFixture } from './helpers/storage-fixture';

const neighborPeer = peer + 1;
const neighborChat = `vk:${neighborPeer}` as const;
const target = 120;
const report = '/сообщить-упоминание ' + chat + ' ' + target;
const accepted = 'Запрос по указанному сообщению обработан.';
type App = Awaited<ReturnType<typeof fixture>>;

function backup(files: ReturnType<typeof storageFixture>, action: 'create' | 'restore') {
  const result = spawnSync(process.execPath, [resolve('dist/app/cli.js'), 'backup', action], {
    cwd: files.directory,
    env: { DATABASE_PATH: files.path, MESSAGE_RETENTION_DAYS: '30' },
    encoding: 'utf8',
    timeout: 20000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: true,
    outcome: action === 'restore' ? 'restored' : 'created',
    verification: { access: { access: 'full' } },
  });
}

async function personalCommand(
  app: App,
  who: number,
  text: string,
  response: string,
  cmid?: number,
) {
  const before = app.sends.length;
  const event = app.submit(text, who, undefined, who, false, cmid);
  await until(() =>
    expect(
      app.sends.slice(before).some((row) => row.peer_id === who && row.text.includes(response)),
    ).toBe(true),
  );
  return event;
}

async function checkRecords(storage: Storage, visible: boolean, pending: boolean) {
  const life = lifecycleBackend(storage);
  const a = life.current(chat);
  const b = life.current(neighborChat);
  for (const [scope, expected] of [
    [a, visible],
    [b, true],
  ] as const) {
    const list = await storage.messages.list(scope, { limit: 100 });
    expect(list.some((row) => row.messageId === String(target) && row.userId === 'vk:42')).toBe(
      expected,
    );
    const hits = await storage.contextMessages.search(scope, 'упоминание', 5, 200);
    expect(hits.map((row) => row.messageId)).toEqual(expected ? [String(target)] : []);
  }
  const privacy = personalDataStore(storage);
  expect(privacy.disputed(a)).toEqual(pending ? [{ messageId: String(target) }] : []);
  expect(privacy.disputed(b)).toEqual([]);
}

test.each([
  ['оставить', 'повтор'],
  ['удалить', 'повтор'],
  ['оставить', 'восстановление'],
  ['удалить', 'восстановление'],
])(
  'личная команда «%s», %s исходной жалобы',
  async (decision, scenario) => {
    const files = storageFixture();
    const options = { files, startAt: Date.now(), profileNotice: 'Уведомление' };
    let app: App | undefined;
    try {
      app = await fixture(options);
      const b = await app.connectGroup(neighborPeer);
      const generationA = app.scope.generation;
      await app.journaled(app.submit('Запись заявителя'));
      await app.journaled(
        app.submit('Упоминание в первой беседе', 42, undefined, peer, false, target),
      );
      app.submit(
        'Контрольное упоминание во второй беседе',
        42,
        undefined,
        neighborPeer,
        false,
        target,
      );
      await until(() => checkRecords(app!.storage, true, false));

      await personalCommand(app, 41, '/удалить-мои-данные ' + chat, '/подтверждаю-удаление');
      const confirmation = app.sends
        .find((row) => row.peer_id === 41 && row.text.includes('/подтверждаю-удаление'))!
        .text.match(/\/подтверждаю-удаление [a-f0-9]{24}/u)![0];
      await personalCommand(app, 41, confirmation, 'Удаление принято.');
      const event = await personalCommand(app, 41, report, accepted);
      await personalCommand(app, 73, '/спорные-записи ' + chat, 'Сообщения на разбор: ' + target);
      await checkRecords(app.storage, false, true);
      if (scenario === 'восстановление') backup(files, 'create');

      const visible = decision === 'оставить';
      await personalCommand(
        app,
        73,
        '/' + decision + '-запись ' + chat + ' ' + target,
        'Решение сохранено.',
      );
      await checkRecords(app.storage, visible, false);
      if (scenario === 'восстановление') {
        await app.close();
        app = undefined;
        backup(files, 'restore');
        const restored = await openStorage(files.path);
        try {
          await checkRecords(restored, visible, false);
        } finally {
          await restored.close();
        }
        app = await fixture({ ...options, resume: true });
        for (const id of [neighborChat, 'vk:41', 'vk:73'] as const)
          await resolveApplicationChat({ databasePath: files.path, ownerId }, id, 'continue');
        expect(app.scope.generation).toBe(generationA);
        expect(lifecycleBackend(app.storage).current(neighborChat).generation).toBe(b.generation);
      }
      await personalCommand(app, 73, '/спорные-записи ' + chat, 'Спорных записей нет.');
      await personalCommand(app, 41, report, accepted, event);
      await checkRecords(app.storage, visible, false);
      personalDataStore(app.storage).cleanup(options.startAt);
      await checkRecords(app.storage, visible, false);
    } finally {
      try {
        await app?.close();
      } finally {
        files.cleanup();
      }
    }
  },
  30000,
);
