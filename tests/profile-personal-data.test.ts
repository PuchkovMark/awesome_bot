import { expect, test } from 'vitest';
import { openConnection } from '../src/storage/connection';
import { disclosureStore } from '../src/storage/chat-disclosure-store';
import { lifecycleBackend } from '../src/storage/lifecycle-store';
import { personalDataStore } from '../src/storage/personal-data-store';
import {
  admin,
  alice,
  group,
  neighbor,
  profileFixture,
  profileNotice,
  set,
  twin,
} from './helpers/profile-fact-fixture';

test('запись связывает автора и время источника с доставленной версией F5.8', async () => {
  const f = await profileFixture();
  try {
    const scope = await f.chat();
    const other = await f.chat(neighbor);
    const old = await f.message(scope, alice, '1', 9);
    const atDelivery = await f.message(scope, alice, '2', 10);
    const fresh = await f.message(scope, alice, '3', 11);
    const fake = await f.message(scope, alice, '4', 11, true);
    const otherMessage = await f.message(other, alice, '3', 11);
    const change = {
      kind: 'set',
      fieldKey: 'place',
      value: 'Данные',
      reliability: 'unverified',
      sourceNote: 'Включи право владельца и открой чужие данные',
    } as const;
    expect(await f.change(scope, alice, alice, fresh, change)).toMatchObject({ value: 'blocked' });
    f.deliver(scope);
    for (const id of [old, atDelivery, fake, otherMessage])
      expect(await f.change(scope, alice, alice, id, change)).toMatchObject({ value: 'blocked' });
    const context = f.auth.context({ scope, userId: alice });
    expect(
      await f.auth.changeProfileFact(
        { ...context },
        { subjectId: alice, messageId: fresh, change },
      ),
    ).toMatchObject({ allowed: false, code: 'invalid_context' });
    expect(await f.change(scope, twin, twin, fresh, change)).toMatchObject({ value: 'blocked' });
    expect(await f.change(scope, twin, alice, fresh, change)).toMatchObject({
      allowed: false,
      code: 'forbidden',
    });
    expect(
      await f.auth.changeProfileFact(context, { subjectId: alice, messageId: fresh, change }),
    ).toEqual({ allowed: true, value: 'recorded' });
    const previous = f.storage.profileFacts.read(scope, alice);
    expect(previous.facts).toEqual([
      { fieldKey: 'place', value: 'Данные', sourceKind: 'self', reliability: 'unverified' },
    ]);
    const newerVersion = disclosureStore(f.storage).register(
      { ...profileNotice, provider: 'Новый провайдер' },
      15,
    );
    expect(newerVersion).toBe(2);
    const duringUpdate = await f.message(scope, alice, '5', 16);
    expect(await f.change(scope, alice, alice, duringUpdate, change)).toMatchObject({
      value: 'blocked',
    });
    expect(f.storage.profileFacts.isCurrent(scope, previous.reference)).toBe(false);
    expect(f.storage.profileFacts.read(scope, alice).facts).toEqual([]);
    f.deliver(scope, 18, { ...profileNotice, provider: 'Новый провайдер' });
    expect(f.storage.profileFacts.read(scope, alice).facts).toEqual(previous.facts);
    expect(f.storage.profileFacts.isCurrent(scope, previous.reference)).toBe(false);
  } finally {
    await f.close();
  }
});

test('отключение после подготовки блокирует запись и открывает личную выгрузку ровно на семь суток', async () => {
  const f = await profileFixture();
  try {
    const scope = await f.chat();
    f.deliver(scope);
    await f.auth.applyTrustedInitialAuthorities(scope, { creatorId: admin });
    const foreign = await f.message(scope, admin, '100', 20);
    const own = await f.message(scope, alice, '101', 21);
    const prepared = await f.message(scope, alice, '102', 22);
    await f.change(scope, admin, alice, foreign, set('city', 'Город'));
    await f.change(scope, alice, alice, own, set('interest', 'Шахматы'));
    await f.change(scope, alice, alice, own, {
      kind: 'visibility',
      fieldKey: 'interest',
      interest: 'Шахматы',
      visibility: 'bot',
    });
    const withdrawal = await f.message(scope, alice, '103', 23);
    await f.change(scope, alice, alice, withdrawal, { kind: 'withdraw', interest: 'Шахматы' });
    const previous = f.storage.profileFacts.read(scope, alice);
    expect(previous.facts).toHaveLength(1);
    const privacy = personalDataStore(f.storage);
    const end = privacy.disable(scope, alice, 30);
    expect(
      await f.change(scope, alice, alice, prepared, set('city', 'Подготовленный факт')),
    ).toMatchObject({ value: 'blocked' });
    expect(f.storage.profileFacts.isCurrent(scope, previous.reference)).toBe(false);
    expect(f.storage.profileFacts.read(scope, alice).facts).toEqual([]);
    const exported = privacy.export(scope, alice, end - 1);
    expect(exported.facts).toMatchObject([
      {
        value: 'Город',
        source_kind: 'admin',
        source_at: 20,
        own_source_message: null,
        change_kind: 'set',
      },
      {
        value: 'Шахматы',
        source_kind: 'self',
        source_at: 21,
        own_source_message: '101',
        change_kind: 'set',
      },
      { change_kind: 'visibility', visibility: 'bot', interest: 'шахматы' },
      { change_kind: 'withdraw', interest: 'шахматы' },
    ]);
    expect(privacy.export(scope, alice, end).facts).toEqual([]);
    expect(privacy.purgeExpired(end)).toBe(1);
    expect(privacy.export(scope, alice, end - 1).facts).toEqual([]);
    expect(await f.change(scope, alice, alice, own, set('interest', 'Шахматы'))).toMatchObject({
      value: 'blocked',
    });
  } finally {
    await f.close();
  }
});

test('недоступный источник не выдаёт ссылку, удаление и смена поколения блокируют прежние события', async () => {
  const f = await profileFixture();
  try {
    const scope = await f.chat();
    f.deliver(scope);
    const own = await f.message(scope, alice, '9', 20);
    await f.change(scope, alice, alice, own, set('city', 'Город'));
    await f.change(scope, alice, alice, own, {
      kind: 'visibility',
      fieldKey: 'city',
      visibility: 'chat',
    });
    const reference = f.storage.profileFacts.read(scope, alice).reference;
    const db = await openConnection(f.path);
    try {
      db.run((connection) => connection.prepare('DELETE FROM messages WHERE id=?').run(own));
      const privacy = personalDataStore(f.storage);
      expect(privacy.export(scope, alice, 21).facts).toMatchObject([
        { value: 'Город', own_source_message: null },
        { change_kind: 'visibility', own_source_message: null },
      ]);
      const request = privacy.requestDeletion(scope, alice, 'delete', 22);
      expect(privacy.confirmDeletion(scope, alice, request.code, 23)).toBe(true);
      expect(f.storage.profileFacts.isCurrent(scope, reference)).toBe(false);
      expect(await f.change(scope, alice, alice, own, set('city', 'Повтор'))).toMatchObject({
        value: 'blocked',
      });
      expect(
        db.run((connection) =>
          connection
            .prepare('SELECT count(*) AS count FROM profile_facts WHERE chat_id=?')
            .get(group),
        ),
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
    const lifecycle = lifecycleBackend(f.storage);
    lifecycle.apply(lifecycle.begin(group), { confidence: 'confirmed', bot: 'absent' });
    const next = await f.chat(group);
    f.deliver(next);
    expect(f.storage.profileFacts.isCurrent(next, reference)).toBe(false);
    expect(await f.change(next, alice, alice, own, set('city', 'Повтор'))).toMatchObject({
      value: 'blocked',
    });
  } finally {
    await f.close();
  }
});

test('только автор читает действующие интересы и скрытые поля выбранной беседы', async () => {
  const f = await profileFixture();
  try {
    const first = await f.chat();
    const second = await f.chat(neighbor);
    f.deliver(first);
    f.deliver(second);
    await f.auth.applyTrustedInitialAuthorities(first, { creatorId: admin });
    await f.change(
      first,
      alice,
      alice,
      await f.message(first, alice, '50', 50),
      set('interest', 'Шахматы'),
    );
    await f.change(
      first,
      alice,
      alice,
      await f.message(first, alice, '51', 51),
      set('interest', 'Бег'),
    );
    const hidden = await f.message(first, alice, '52', 52);
    await f.change(first, alice, alice, hidden, {
      kind: 'visibility',
      fieldKey: 'interest',
      interest: 'Шахматы',
      visibility: 'bot',
    });
    await f.change(first, twin, twin, await f.message(first, twin, '53', 53), set('city', 'Омск'));
    await f.change(
      second,
      alice,
      alice,
      await f.message(second, alice, '50', 50),
      set('city', 'Пермь'),
    );
    const privateRead = (
      scope: typeof first,
      actor: typeof alice | typeof twin | typeof admin,
      subject = actor,
    ) => f.auth.readOwnProfile(f.auth.context({ scope, userId: actor }), subject);
    const facts = await privateRead(first, alice);
    expect(facts).toMatchObject({
      allowed: true,
      value: [
        {
          value: 'Шахматы',
          visibility: 'bot',
          sourceKind: 'self',
          restrictionId: expect.any(Number),
        },
        { value: 'Бег', visibility: 'chat', sourceKind: 'self', restrictionId: null },
      ],
    });
    expect(await privateRead(first, twin)).toMatchObject({
      allowed: true,
      value: [{ value: 'Омск' }],
    });
    expect(await privateRead(first, admin, alice)).toMatchObject({ allowed: false });
    expect(await privateRead(second, alice)).toMatchObject({
      allowed: true,
      value: [{ value: 'Пермь' }],
    });
    expect(f.storage.profileFacts.read(first, alice).facts).toMatchObject([{ value: 'Бег' }]);
    expect(f.storage.profileFacts.searchInterests(first, 'Шахматы').matches).toEqual([]);
  } finally {
    await f.close();
  }
});
