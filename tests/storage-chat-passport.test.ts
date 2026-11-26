import { expect, test } from 'vitest';
import { glossaryBotNames, matchGroupBotName } from '../src/core/message-router/name-address';
import type { ConnectionScope, UserId } from '../src/contracts/index';
import { createAuthorizationService } from '../src/core/index';
import { chatPassportStore } from '../src/storage/chat-passport-store';
import {
  passportPromptLifetime,
  passportSections,
  type PassportPromptAction,
  type PassportSection,
} from '../src/storage/chat-passport-types';
import { lifecycleBackend } from '../src/storage/lifecycle-store';
import { openStorage, scopeFor } from './helpers/connection-scope';
import { storageFixture } from './helpers/storage-fixture';

const main = 'vk:2000000041';
const neighbor = 'vk:2000000042';
const owner = 'vk:73';
const other = 'vk:41';
const start = Date.UTC(2026, 10, 23, 12);
const allowed = (value: string) => ({ allowed: true, value });

async function setup() {
  const files = storageFixture();
  let storage = await openStorage(files.path);
  let now = start;
  let auth = await connect();
  async function connect() {
    return createAuthorizationService({
      config: { ownerId: owner, reasonMaxLength: 500, reasonRetentionDays: 90 },
      store: storage.authorization,
      now: () => now,
    });
  }
  for (const id of [main, neighbor]) {
    const scope = scopeFor(storage, id);
    await storage.chats.create(scope, { enabled: true, responseMode: 'normal', createdAt: start });
    await storage.authorization.transaction(scope, (tx) =>
      tx.grant({
        userId: other,
        basis: 'explicit',
        grantedAt: start,
        grantedBy: owner,
      }),
    );
  }
  const passport = () => chatPassportStore(storage);
  return {
    get storage() {
      return storage;
    },
    passport,
    at: (offset: number) => {
      now = start + offset;
    },
    read(scope: ConnectionScope, section: PassportSection) {
      return passport()
        .read(scope)
        .find((entry) => entry.section === section)!;
    },
    prompt(
      scope: ConnectionScope,
      section: PassportSection,
      receipt: number,
      action: PassportPromptAction = 'edit',
      actor: UserId = owner,
    ) {
      expect(
        passport().recordPrompt(
          scope,
          actor,
          passport()
            .read(scope)
            .find((entry) => entry.section === section)!,
          action,
          {
            messageId: String(receipt),
            authorName: 'Пенёк',
            userId: 'vk:-314',
            text: 'Подсказка',
            timestamp: now,
          },
          now,
        ),
      ).toBe(true);
    },
    apply(
      scope: ConnectionScope,
      receipt: number,
      event: number,
      text: string,
      actor: UserId = owner,
    ) {
      return auth.applyPassportReply(
        auth.context({ scope, userId: actor }),
        { receipt: String(receipt), eventId: event, eventAt: now, text },
        () => true,
      );
    },
    async reopen() {
      auth.dispose();
      await storage.close();
      storage = await openStorage(files.path);
      auth = await connect();
    },
    async close() {
      auth.dispose();
      await storage.close();
      files.cleanup();
    },
  };
}

test('паспорт начинает с пустого снимка, хранит ровно 3000 байт и изолирует беседы после перезапуска', async () => {
  const f = await setup();
  try {
    let scope = scopeFor(f.storage, main);
    let second = scopeFor(f.storage, neighbor);
    expect(f.passport().read(scope)).toEqual(
      passportSections.map((section) => ({ section, text: null, revision: 0 })),
    );
    const boundary = 'я'.repeat(1497) + '\n🙂 ';
    expect(Buffer.byteLength(boundary)).toBe(3000);
    f.prompt(scope, 'rules', 101);
    expect(await f.apply(scope, 101, 201, '  \n')).toEqual(allowed('empty'));
    expect(await f.apply(scope, 101, 202, ' ' + boundary)).toEqual(allowed('too_long'));
    expect(await f.apply(scope, 101, 203, boundary)).toEqual(allowed('applied'));
    f.prompt(second, 'rules', 101);
    expect(await f.apply(second, 101, 203, 'Другая беседа')).toEqual(allowed('applied'));
    await f.reopen();
    scope = scopeFor(f.storage, main);
    second = scopeFor(f.storage, neighbor);
    expect(f.read(scope, 'rules')).toEqual({ section: 'rules', text: boundary, revision: 1 });
    expect(f.read(second, 'rules').text).toBe('Другая беседа');
    expect(await f.apply(scope, 101, 203, 'Повтор')).toEqual(allowed('duplicate'));
  } finally {
    await f.close();
  }
});

test('гонка одних разделов сохраняет победителя, независимые правки проходят, очистка хранит ревизию', async () => {
  const f = await setup();
  try {
    const scope = scopeFor(f.storage, main);
    f.prompt(scope, 'rules', 101);
    f.prompt(scope, 'rules', 102, 'edit', other);
    f.prompt(scope, 'traditions', 103, 'edit', other);
    expect(
      await Promise.all([
        f.apply(scope, 101, 201, 'Правила'),
        f.apply(scope, 102, 202, 'Другая редакция', other),
        f.apply(scope, 103, 203, 'Традиция', other),
      ]),
    ).toEqual([allowed('applied'), allowed('stale'), allowed('applied')]);
    f.prompt(scope, 'rules', 104, 'edit', other);
    f.prompt(scope, 'rules', 105, 'clear');
    expect(await f.apply(scope, 104, 204, 'Подтверждаю', other)).toEqual(
      allowed('invalid_confirmation'),
    );
    expect(await f.apply(scope, 105, 205, 'Текст')).toEqual(allowed('invalid_confirmation'));
    expect(await f.apply(scope, 105, 206, 'Подтверждаю', other)).toEqual(allowed('closed'));
    expect(await f.apply(scope, 105, 207, 'Подтверждаю')).toEqual(allowed('applied'));
    expect(f.read(scope, 'rules')).toEqual({ section: 'rules', revision: 2, text: null });
    expect(f.read(scope, 'traditions').text).toBe('Традиция');
    f.prompt(scope, 'rules', 106);
    expect(await f.apply(scope, 106, 208, 'Повторное заполнение')).toEqual(allowed('applied'));
    expect(await f.apply(scope, 104, 209, 'Устаревшее', other)).toEqual(allowed('stale'));
    expect(f.read(scope, 'rules')).toMatchObject({ revision: 3, text: 'Повторное заполнение' });
  } finally {
    await f.close();
  }
});

test('местные имена бота берутся из выделенной строки глоссария текущей беседы и редакции', async () => {
  const f = await setup();
  try {
    const scope = scopeFor(f.storage, main);
    const second = scopeFor(f.storage, neighbor);
    const names = (target: ConnectionScope) => glossaryBotNames(f.read(target, 'glossary'));
    f.prompt(scope, 'glossary', 101);
    expect(
      await f.apply(
        scope,
        101,
        201,
        'Местный словарь: Хранитель\nИмена бота — Лесовик, Добрый Дядя',
      ),
    ).toEqual(allowed('applied'));
    expect(matchGroupBotName('Подскажи ДОБРЫЙ ДЯДЯ что делать', names(scope))).toEqual({
      glossaryRevision: 1,
    });
    expect(matchGroupBotName('Лесовик', names(scope))).toEqual({ glossaryRevision: 1 });
    expect(matchGroupBotName('Хранитель', names(scope))).toBeNull();
    expect(matchGroupBotName('Лесовик', names(second))).toBeNull();
    f.prompt(second, 'glossary', 101);
    expect(await f.apply(second, 101, 201, 'Имена бота — Лесовик')).toEqual(allowed('applied'));
    f.prompt(scope, 'glossary', 102);
    expect(await f.apply(scope, 102, 202, 'Имена бота — Ёлкин')).toEqual(allowed('applied'));
    expect(matchGroupBotName('Лесовик', names(scope))).toBeNull();
    expect(matchGroupBotName('Елкин', names(scope))).toEqual({ glossaryRevision: 2 });
    f.prompt(scope, 'glossary', 103, 'clear');
    expect(await f.apply(scope, 103, 203, 'Подтверждаю')).toEqual(allowed('applied'));
    expect(matchGroupBotName('Ёлкин', names(scope))).toBeNull();
    expect(matchGroupBotName('Лесовик', names(second))).toEqual({ glossaryRevision: 1 });
  } finally {
    await f.close();
  }
});

test('подсказки живут ровно 15 минут, переживают открытие БД и очищаются при сбросе', async () => {
  const f = await setup();
  try {
    let scope = scopeFor(f.storage, main);
    f.prompt(scope, 'events', 101);
    f.prompt(scope, 'topic', 102);
    await f.reopen();
    scope = scopeFor(f.storage, main);
    f.at(passportPromptLifetime - 1);
    expect(await f.apply(scope, 101, 201, 'События')).toEqual(allowed('applied'));
    f.at(passportPromptLifetime);
    expect(await f.apply(scope, 102, 202, 'Слишком поздно')).toEqual(allowed('closed'));
    f.passport().prune(start + passportPromptLifetime);
    expect(f.passport().sectionForReply(scope, '102')).toBe('topic');
    f.prompt(scope, 'topic', 103);
    const life = lifecycleBackend(f.storage);
    life.ownerDelete(life.begin(scope.chatId), scope.generation);
    const replacement = scopeFor(f.storage, main);
    await f.storage.chats.create(replacement, {
      enabled: true,
      responseMode: 'normal',
      createdAt: start,
    });
    expect(
      f
        .passport()
        .read(replacement)
        .every((entry) => entry.text === null),
    ).toBe(true);
    expect(f.passport().sectionForReply(replacement, '103')).toBeUndefined();
    expect(await f.apply(replacement, 103, 203, 'Старая подсказка')).toEqual(allowed('closed'));
  } finally {
    await f.close();
  }
});
