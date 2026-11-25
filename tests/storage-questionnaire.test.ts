import { expect, test } from 'vitest';
import type { ConnectionScope, UserId } from '../src/contracts/index';
import { createAuthorizationService } from '../src/core/index';
import { legacyQuestionnaire } from '../src/core/questionnaires/legacy-template';
import { lifecycleBackend } from '../src/storage/lifecycle-store';
import { questionnaireStore } from '../src/storage/questionnaire-store';
import { openStorage, scopeFor } from './helpers/connection-scope';
import { seedBeforeQuestionnaires } from './helpers/questionnaire-upgrade';
import { storageFixture } from './helpers/storage-fixture';

const early = 'vk:2000000041';
const neighbor = 'vk:2000000042';
const fresh = 'vk:2000000043';
const owner = 'vk:73';
const admin = 'vk:41';
const now = 100;

async function setup(upgrade = false) {
  const file = storageFixture();
  if (upgrade) seedBeforeQuestionnaires(file.path, [early, neighbor]);
  let storage = await openStorage(file.path);
  let auth = await createAuth();
  function createAuth() {
    return createAuthorizationService({
      config: { ownerId: owner, reasonMaxLength: 500, reasonRetentionDays: 90 },
      store: storage.authorization,
      now: () => now,
    });
  }
  for (const chatId of [early, neighbor, fresh]) {
    const scope = scopeFor(storage, chatId);
    await storage.chats.create(scope, { enabled: true, responseMode: 'normal', createdAt: now });
    await storage.authorization.transaction(scope, (tx) =>
      tx.grant({ userId: admin, basis: 'explicit', grantedBy: owner, grantedAt: now }),
    );
  }
  const store = () => questionnaireStore(storage);
  return {
    get storage() {
      return storage;
    },
    store,
    prompt(scope: ConnectionScope, receipt: number, actor: UserId = owner) {
      const shown = store().current(scope)?.ref.revision ?? 0;
      expect(
        store().recordPrompt(scope, actor, shown, {
          messageId: String(receipt),
          timestamp: now,
          text: 'Редактор',
          authorName: 'Пенёк',
          userId: 'vk:-314',
        }),
      ).toBe(true);
    },
    async replace(
      scope: ConnectionScope,
      receipt: number,
      eventId: number,
      text: string,
      actor: UserId = owner,
    ) {
      return auth.applyQuestionnaireReply(
        auth.context({ scope, userId: actor }),
        {
          receipt: String(receipt),
          eventId,
          text,
        },
        () => true,
      );
    },
    async reopen() {
      auth.dispose();
      await storage.close();
      storage = await openStorage(file.path);
      auth = await createAuth();
    },
    async close() {
      auth.dispose();
      await storage.close();
      file.cleanup();
    },
  };
}

test('миграция отделяет новые VK-группы от прежних, локальная редакция переживает перезапуск', async () => {
  const f = await setup(true);
  try {
    let old = scopeFor(f.storage, early);
    const modern = scopeFor(f.storage, fresh);
    expect(f.store().current(old)).toBeNull();
    expect(f.store().current(scopeFor(f.storage, neighbor))).toBeNull();
    expect(f.store().current(modern)?.questions).toEqual(legacyQuestionnaire.questions);
    expect(f.store().current(scopeFor(f.storage, 'vk:41'))).toBeNull();
    expect(f.store().current(scopeFor(f.storage, 'test:2000000041'))).toBeNull();
    f.prompt(old, 101);
    expect(f.store().current(old)).toBeNull();
    expect(
      await f.replace(old, 101, 201, 'Местный вопрос?\r\n  https://example.test/abc  '),
    ).toEqual({
      allowed: true,
      value: { status: 'applied', count: 2 },
    });
    const first = f.store().current(old)!;
    f.prompt(old, 102);
    await f.reopen();
    old = scopeFor(f.storage, early);
    expect(f.store().current(old)).toEqual(first);
    expect(await f.replace(old, 102, 202, 'Другая редакция?')).toMatchObject({
      allowed: true,
      value: { status: 'confirm', before: 2, question: 'Другая редакция?' },
    });
    expect(
      f
        .store()
        .get(old, first.ref)
        ?.questions.map(({ text }) => text),
    ).toEqual(['Местный вопрос?', '  https://example.test/abc  ']);
    expect(f.store().current(scopeFor(f.storage, neighbor))).toBeNull();
    expect(f.store().get(scopeFor(f.storage, neighbor), first.ref)).toBeNull();
  } finally {
    await f.close();
  }
});

test('привязка захватывает редакцию, один ответ побеждает, повтор и сброс безопасны', async () => {
  const f = await setup();
  try {
    const scope = scopeFor(f.storage, early);
    const original = f.store().current(scope)!;
    expect(original.ref.revision).toBe(1);
    const before = 'я'.repeat(1997) + '\n🙂 ';
    expect(Buffer.byteLength(before)).toBe(4000);
    f.prompt(scope, 101);
    f.prompt(scope, 102, admin);
    expect(await f.replace(scope, 101, 200, ' \n')).toMatchObject({ value: { status: 'empty' } });
    expect(await f.replace(scope, 101, 201, before + ' ')).toMatchObject({
      value: { status: 'too_long' },
    });
    expect(await f.replace(scope, 101, 202, 'От другого автора', admin)).toMatchObject({
      value: { status: 'closed' },
    });
    expect(
      await Promise.all([
        f.replace(scope, 101, 203, before),
        f.replace(scope, 102, 204, 'Старая редакция', admin),
      ]),
    ).toMatchObject([{ value: { status: 'applied', count: 2 } }, { value: { status: 'stale' } }]);
    expect(await f.replace(scope, 101, 203, before)).toMatchObject({
      value: { status: 'duplicate' },
    });
    const current = f.store().current(scope)!;
    expect(current.questions.map(({ text }) => text).join('\n')).toBe(before);
    expect(f.store().get(scope, original.ref)).toEqual(original);
    expect(f.store().current(scopeFor(f.storage, neighbor))?.questions).toEqual(original.questions);

    f.prompt(scope, 103);
    const life = lifecycleBackend(f.storage);
    life.ownerDelete(life.begin(scope.chatId), scope.generation);
    const replacement = scopeFor(f.storage, early);
    await f.storage.chats.create(replacement, {
      enabled: true,
      responseMode: 'normal',
      createdAt: now,
    });
    expect(f.store().hasPrompt(replacement, '103')).toBe(false);
    expect(f.store().get(replacement, current.ref)).toBeNull();
    expect(f.store().current(replacement)?.questions).toEqual(legacyQuestionnaire.questions);
  } finally {
    await f.close();
  }
});
