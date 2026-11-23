import { expect, test } from 'vitest';
import { admin, alice, neighbor, profileFixture, set } from './helpers/profile-fact-fixture';

test('карточка выбирает видимые факты по источнику и времени события, а зависимости относятся к конкретному значению', async () => {
  const f = await profileFixture();
  try {
    const scope = await f.chat();
    const other = await f.chat(neighbor);
    f.deliver(scope);
    f.deliver(other);
    await f.storage.authorization.transaction(scope, (tx) =>
      tx.grant({ userId: admin, basis: 'explicit', grantedAt: 1, grantedBy: 'vk:owner' }),
    );
    const oldSelf = await f.message(scope, alice, '200', 20);
    const newSelf = await f.message(scope, alice, '201', 25);
    const privateFact = await f.message(scope, alice, '202', 30);
    const fromAdmin = await f.message(scope, admin, '203', 50);
    const inferred = await f.message(scope, alice, '204', 60);
    const next = await f.message(other, alice, '200', 20);
    expect(
      await f.change(scope, admin, alice, fromAdmin, set('admin', 'Администратор')),
    ).toMatchObject({
      value: 'recorded',
    });
    expect(f.infer(scope, alice, inferred, set('inferred', 'Вывод'))).toBe('recorded');
    await f.change(scope, alice, alice, newSelf, set('skill', 'Новый факт', 'confirmed'));
    await f.change(scope, alice, alice, oldSelf, set('city', 'Старое утверждение'));
    await f.change(scope, alice, alice, privateFact, set('private', 'Закрытое значение'));
    await f.change(scope, alice, alice, privateFact, {
      kind: 'visibility',
      fieldKey: 'private',
      visibility: 'bot',
    });
    await f.change(other, alice, alice, next, set('city', 'Соседнее значение'));
    const profiles = f.storage.profileFacts;
    const [first, second] = profiles.cardFacts(scope, alice);
    expect([first?.value, second?.value]).toEqual([
      { fieldKey: 'skill', value: 'Новый факт', sourceKind: 'self', reliability: 'confirmed' },
      {
        fieldKey: 'city',
        value: 'Старое утверждение',
        sourceKind: 'self',
        reliability: 'unverified',
      },
    ]);
    expect([first?.sourceIds, second?.sourceIds]).toEqual([[newSelf], [oldSelf]]);
    expect(profiles.cardFacts(other, alice).map(({ value }) => value.value)).toEqual([
      'Соседнее значение',
    ]);
    expect(profiles.cardFactsCurrent(scope, [first!.reference, second!.reference])).toBe(true);
    expect(profiles.cardFactsCurrent(other, [first!.reference])).toBe(false);

    const hiding = await f.message(scope, alice, '205', 70);
    await f.change(scope, alice, alice, hiding, {
      kind: 'visibility',
      fieldKey: 'city',
      visibility: 'bot',
    });
    expect(profiles.cardFacts(scope, alice).map(({ value }) => value.value)).toEqual([
      'Новый факт',
      'Администратор',
    ]);
    expect(profiles.cardFactsCurrent(scope, [second!.reference])).toBe(false);
    expect(profiles.cardFactsCurrent(scope, [first!.reference])).toBe(true);
  } finally {
    await f.close();
  }
});
