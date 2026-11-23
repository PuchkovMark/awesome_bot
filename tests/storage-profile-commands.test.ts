import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import type { ConnectionScope } from '../src/contracts/index';
import { lifecycleBackend } from '../src/storage/lifecycle-store';
import { personalDataStore } from '../src/storage/personal-data-store';
import { reconcileStagedPersonalData } from '../src/storage/personal-data-restore';
import { profileCommandStore } from '../src/storage/profile-command-store';
import type { ProfileCommandChange } from '../src/storage/profile-command-types';
import { scopeFor } from './helpers/connection-scope';
import { alice, group, neighbor, profileFixture, set, twin } from './helpers/profile-fact-fixture';
import { storageFixture } from './helpers/storage-fixture';

const lifetime = 86_400_000;
const now = 100;

async function setup(f: Awaited<ReturnType<typeof profileFixture>>) {
  const target = await f.chat();
  const other = await f.chat(neighbor);
  const direct = await f.chat(alice, [alice]);
  const secondActor = await f.chat(twin, [twin]);
  for (const scope of [target, other, direct, secondActor]) f.deliver(scope);
  const message = await f.message(target, alice, '200', 20);
  expect(await f.change(target, alice, alice, message, set('city', 'Пермь'))).toMatchObject({
    value: 'recorded',
  });
  await f.change(target, alice, alice, message, set('interest', 'Каяки'));
  await f.change(target, alice, alice, message, set('interest', 'Шахматы'));
  return { target, other, direct, secondActor };
}

function event(scope: ConnectionScope, messageId: string, at = now) {
  return { scope, messageId, at };
}

function editing(f: Awaited<ReturnType<typeof profileFixture>>, scope: ConnectionScope) {
  return (id: string, replyId: string, position: number, change: ProfileCommandChange, at = now) =>
    f.storage.authorization.transaction(scope, (tx) =>
      tx.editOwnProfile(scope.chatId, { messageId: id, at, replyId, position, change }, at),
    );
}

test('привязки позиций действуют только по подтверждённым частям, в личке автора и ровно 24 часа', async () => {
  const f = await profileFixture();
  try {
    const { target, other, direct, secondActor } = await setup(f);
    const store = profileCommandStore(f.storage);
    const edit = editing(f, direct);
    const hide = { kind: 'hide' } as const;
    const list = store.open(alice, direct, target, event(target, '300'), now)!;
    expect(list.facts.map((fact) => fact.value)).toEqual(['Пермь', 'Каяки', 'Шахматы']);
    const parts = store.parts(
      list,
      [
        { first: 1, last: 1 },
        { first: 1, last: 2 },
        { first: 3, last: 3 },
      ],
      now,
    )!;
    expect(store.confirm(list, 1, parts[0]!.sendId, '200', now)).toBe(true);
    expect(store.confirm(list, 3, parts[2]!.sendId, '202', now)).toBe(true);
    expect(await edit('301', '200', 1, hide)).toBe('stale');
    expect(await edit('302', '202', 2, hide)).toBe('stale');
    expect(await editing(f, secondActor)('301', '202', 3, hide)).toBe('stale');
    expect(store.confirm(list, 2, parts[1]!.sendId, '201', now)).toBe(true);
    expect(await edit('301', '200', 1, hide)).toBe('duplicate');

    const switched = store.open(alice, direct, other, event(direct, '307'), now)!;
    expect(switched.facts).toEqual([]);
    expect(await edit('303', '200', 1, hide)).toBe('stale');
    expect(store.confirm(list, 1, parts[0]!.sendId, '205', now)).toBe(false);
    expect(store.open(alice, direct, target, event(target, '300'), now)).toBeNull();

    const latest = store.open(alice, direct, target, event(direct, '304'), now)!;
    const [part] = store.parts(latest, [{ first: 1, last: 3 }], now)!;
    expect(store.confirm(latest, 1, part!.sendId, '203', now)).toBe(true);
    await f.reopen();
    const reopened = editing(f, scopeFor(f.storage, alice));
    expect(await reopened('304', '203', 3, hide)).toBe('duplicate');
    expect(await reopened('305', '203', 3, hide, now + lifetime - 1)).toBe('applied');
    expect(await reopened('306', '203', 1, hide, now + lifetime)).toBe('stale');
    profileCommandStore(f.storage).prune(now + lifetime);
    const db = new Database(f.path, { readonly: true });
    try {
      expect(db.prepare('SELECT * FROM profile_command_lists').all()).toEqual([]);
      expect(db.prepare('SELECT * FROM profile_command_positions').all()).toEqual([]);
      expect(db.prepare('SELECT * FROM profile_command_parts').all()).toEqual([]);
      expect(
        db.prepare('SELECT event_id FROM profile_command_events ORDER BY event_id').all(),
      ).toEqual([{ event_id: '305' }, { event_id: '306' }]);
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});

test('правка сохраняет скрытие, заменяет только выбранный интерес и учитывает отказ от вывода', async () => {
  const f = await profileFixture();
  try {
    const { target, other, direct } = await setup(f);
    const inOther = await f.message(other, alice, '200', 20);
    await f.change(other, alice, alice, inOther, set('city', 'Казань'));
    await f.change(other, alice, alice, inOther, set('interest', 'Каяки'));
    const store = profileCommandStore(f.storage);
    const present = await f.message(target, alice, '201', 21);
    const newer = await f.message(target, alice, '202', 22);
    f.infer(target, alice, present, set('hobby', 'Прежний вывод'));
    f.infer(target, alice, newer, set('hobby', 'Действующий вывод'));
    const view = (id: number, at: number) => {
      const list = store.open(alice, direct, target, event(direct, String(id), at), at)!;
      const [part] = store.parts(list, [{ first: 1, last: list.facts.length }], at)!;
      expect(store.confirm(list, 1, part!.sendId, String(id + 1), at)).toBe(true);
      return list.facts;
    };
    const edit = editing(f, direct);
    const first = view(400, now);
    const kayaks = first.findIndex((fact) => fact.value === 'Каяки') + 1;
    expect(
      await Promise.all([
        edit('402', '401', kayaks, { kind: 'hide' }),
        edit('403', '401', kayaks, { kind: 'correct', value: 'Лодки' }),
      ]),
    ).toEqual(['applied', 'stale']);

    const hidden = view(410, now + 1);
    expect(hidden.find((fact) => fact.value === 'Каяки')?.visibility).toBe('bot');
    expect(await edit('412', '411', kayaks, { kind: 'correct', value: 'Каноэ' }, now + 1)).toBe(
      'applied',
    );
    const corrected = view(420, now + 2);
    expect(corrected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 'Каноэ', visibility: 'bot', sourceKind: 'self' }),
        expect.objectContaining({ value: 'Шахматы', visibility: 'chat' }),
      ]),
    );
    expect(corrected.some((fact) => fact.value === 'Каяки')).toBe(false);
    const canoe = corrected.findIndex((fact) => fact.value === 'Каноэ') + 1;
    const inferred = corrected.findIndex((fact) => fact.value === 'Действующий вывод') + 1;
    expect(await edit('422', '421', canoe, { kind: 'reject' }, now + 2)).toBe('not_inferred');
    expect(await edit('423', '421', inferred, { kind: 'reject' }, now + 2)).toBe('applied');
    const after = view(430, now + 3);
    expect(after.some((fact) => fact.fieldKey === 'hobby')).toBe(false);
    const read = (scope: ConnectionScope) =>
      f.storage.authorization.transaction(scope, (tx) => tx.readOwnProfile(alice, now + 3));
    expect((await read(other)).map((fact) => [fact.value, fact.visibility])).toEqual([
      ['Казань', 'chat'],
      ['Каяки', 'chat'],
    ]);
    await f.reopen();
    expect(await read(scopeFor(f.storage, group))).toEqual(after);
    const db = new Database(f.path, { readonly: true });
    try {
      expect(
        db.prepare("SELECT source_message_id FROM profile_facts WHERE value='Каноэ'").get(),
      ).toEqual({
        source_message_id: null,
      });
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});

test('удаление и восстановление старой копии инвалидируют выданные личные номера', async () => {
  const f = await profileFixture();
  const backup = storageFixture();
  try {
    const { target, other, direct } = await setup(f);
    const store = profileCommandStore(f.storage);
    const list = store.open(alice, direct, target, event(direct, '500'), now)!;
    const [part] = store.parts(list, [{ first: 1, last: 3 }], now)!;
    expect(store.confirm(list, 1, part!.sendId, '501', now)).toBe(true);
    const db = new Database(f.path);
    try {
      await db.backup(backup.path);
      const privacy = personalDataStore(f.storage);
      const request = privacy.requestDeletion(target, alice, 'delete-046', now + 1);
      expect(privacy.confirmDeletion(target, alice, request.code, now + 1)).toBe(true);
      expect(await editing(f, direct)('502', '501', 1, { kind: 'hide' })).toBe('stale');
      expect(db.prepare('SELECT * FROM profile_command_lists').all()).toEqual([]);

      store.open(alice, direct, other, event(direct, '503'), now + 2);
      const staged = new Database(backup.path);
      const readonly = new Database(f.path, { readonly: true });
      try {
        staged.pragma('foreign_keys=ON');
        reconcileStagedPersonalData(staged, readonly, now + 3);
        expect(staged.prepare('SELECT * FROM profile_command_lists').all()).toEqual([]);
        expect(staged.prepare('SELECT * FROM profile_facts WHERE chat_id=?').all(group)).toEqual(
          [],
        );
        expect(staged.pragma('foreign_key_check')).toEqual([]);
      } finally {
        readonly.close();
        staged.close();
      }
    } finally {
      db.close();
    }
  } finally {
    backup.cleanup();
    await f.close();
  }
});

test.each(['target', 'direct'] as const)(
  'сброс области %s удаляет привязку в обоих чатах',
  async (reset) => {
    const f = await profileFixture();
    try {
      const scopes = await setup(f);
      const { target, direct } = scopes;
      const store = profileCommandStore(f.storage);
      const list = store.open(alice, direct, target, event(target, '600'), now)!;
      const [part] = store.parts(list, [{ first: 1, last: 3 }], now)!;
      expect(store.confirm(list, 1, part!.sendId, '601', now)).toBe(true);
      const life = lifecycleBackend(f.storage);
      const scope = scopes[reset];
      life.ownerDelete(life.begin(scope.chatId), scope.generation);
      const db = new Database(f.path, { readonly: true });
      try {
        for (const table of [
          'profile_command_lists',
          'profile_command_positions',
          'profile_command_parts',
        ])
          expect(db.prepare(`SELECT count(*) FROM ${table}`).pluck().get()).toBe(0);
        expect(db.pragma('foreign_key_check')).toEqual([]);
      } finally {
        db.close();
      }
    } finally {
      await f.close();
    }
  },
);
