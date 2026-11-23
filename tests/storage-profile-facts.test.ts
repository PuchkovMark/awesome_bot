import { expect, test, vi } from 'vitest';
import { openConnection } from '../src/storage/connection';
import { personalDataStore } from '../src/storage/personal-data-store';
import { profileCommandStore } from '../src/storage/profile-command-store';
import { lifecycleBackend } from '../src/storage/lifecycle-store';
import {
  admin,
  alice,
  group,
  neighbor,
  profileFixture,
  set,
  twin,
} from './helpers/profile-fact-fixture';
import { scopeFor } from './helpers/connection-scope';

test.each([false, true])(
  'источник, UTC и порядок исходных событий, очередь в обратном порядке=%s',
  async (reverse) => {
    const f = await profileFixture();
    try {
      const scope = await f.chat();
      f.deliver(scope);
      await f.auth.applyTrustedInitialAuthorities(scope, { creatorId: admin });
      const older = await f.message(scope, alice, '9', 30);
      const newer = await f.message(scope, alice, '10', 30);
      const late = await f.message(scope, alice, '11', 29);
      const inference = await f.message(scope, alice, '12', 90);
      const added = await f.message(scope, admin, '13', 100);
      const operations = [
        () => f.change(scope, alice, alice, older, set('city', 'Пермь')),
        () => f.change(scope, alice, alice, newer, set('city', 'Уфа')),
        () => f.change(scope, alice, alice, late, set('city', 'Казань')),
        () => f.infer(scope, alice, inference, set('city', 'Тверь', 'confirmed')),
        () => f.change(scope, admin, alice, added, set('city', 'Омск', 'confirmed')),
      ];
      for (const operation of reverse ? operations.reverse() : operations) await operation();
      expect(await f.change(scope, alice, alice, older, set('city', 'Подмена'))).toEqual({
        allowed: true,
        value: 'duplicate',
      });
      expect(f.storage.profileFacts.read(scope, alice).facts).toEqual([
        { fieldKey: 'city', value: 'Уфа', sourceKind: 'self', reliability: 'unverified' },
      ]);
      const correction = await f.message(scope, alice, '14', 31);
      await f.change(scope, alice, alice, correction, set('city', 'Псков'));
      expect(f.storage.profileFacts.read(scope, alice).facts[0]?.value).toBe('Псков');
      const db = await openConnection(f.path);
      try {
        expect(
          db.run((connection) =>
            connection
              .prepare(
                'SELECT source_user_id,source_message_id,source_at,source_kind,reliability FROM profile_facts WHERE value=?',
              )
              .get('Псков'),
          ),
        ).toEqual({
          source_user_id: alice,
          source_message_id: '14',
          source_at: 31,
          source_kind: 'self',
          reliability: 'unverified',
        });
      } finally {
        db.close();
      }
    } finally {
      await f.close();
    }
  },
);

test('две группы, личный диалог и тёзки сохраняют раздельные факты после перезапуска', async () => {
  const f = await profileFixture();
  try {
    const cases = [
      [group, alice, 'Север'],
      [group, twin, 'Восток'],
      [neighbor, alice, 'Запад'],
      [alice, alice, 'Юг'],
    ] as const;
    for (const [index, [chatId, user, value]] of cases.entries()) {
      const scope = await f.chat(chatId, chatId === alice ? [alice] : undefined);
      if (index !== 1) f.deliver(scope);
      const evidence = await f.message(scope, user, String(20 + index), 20);
      expect(await f.change(scope, user, user, evidence, set('place', value, 'confirmed'))).toEqual(
        {
          allowed: true,
          value: 'recorded',
        },
      );
    }
    await f.reopen();
    for (const [index, [chatId, user, value]] of cases.entries()) {
      const scope = scopeFor(f.storage, chatId);
      expect(f.storage.profileFacts.read(scope, user).facts).toEqual([
        { fieldKey: 'place', value, sourceKind: 'self', reliability: 'confirmed' },
      ]);
      expect(personalDataStore(f.storage).export(scope, user, 50).facts).toMatchObject([
        {
          value,
          source_kind: 'self',
          source_at: 20,
          own_source_message: String(20 + index),
          visibility: 'chat',
          reliability: 'confirmed',
        },
      ]);
    }
    const old = scopeFor(f.storage, group);
    const lifecycle = lifecycleBackend(f.storage);
    lifecycle.apply(lifecycle.begin(group), { confidence: 'confirmed', bot: 'absent' });
    expect(() => f.storage.profileFacts.read(old, alice)).toThrow();
    expect(f.storage.profileFacts.read(scopeFor(f.storage, neighbor), alice).facts).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('снятие шахмат не снимает бег, поздний вывод и повтор не возвращают шахматы', async () => {
  const f = await profileFixture();
  try {
    let scope = await f.chat();
    f.deliver(scope);
    const chess = await f.message(scope, alice, '20', 20);
    const running = await f.message(scope, alice, '21', 21);
    const withdraw = await f.message(scope, alice, '22', 22);
    await f.change(scope, alice, alice, chess, set('interest', 'Шахматы'));
    await f.change(scope, alice, alice, running, set('interest', 'Бег'));
    expect(f.storage.profileFacts.read(scope, alice).facts.map(({ value }) => value)).toEqual([
      'Шахматы',
      'Бег',
    ]);
    await f.change(scope, alice, alice, withdraw, { kind: 'withdraw', interest: ' шахматы ' });
    await f.reopen();
    scope = scopeFor(f.storage, group);
    expect(await f.change(scope, alice, alice, chess, set('interest', 'ШАХМАТЫ'))).toMatchObject({
      value: 'duplicate',
    });
    expect(
      f.infer(scope, alice, await f.message(scope, alice, '23', 25), set('interest', 'Шахматы')),
    ).toBe('recorded');
    expect(f.storage.profileFacts.read(scope, alice).facts.map(({ value }) => value)).toEqual([
      'Бег',
    ]);
    await f.change(
      scope,
      alice,
      alice,
      await f.message(scope, alice, '24', 26),
      set('interest', 'Шахматы'),
    );
    expect(f.storage.profileFacts.read(scope, alice).facts.map(({ value }) => value)).toEqual([
      'Бег',
      'Шахматы',
    ]);
  } finally {
    await f.close();
  }
});

test.each([false, true])(
  'прямой отказ имеет приоритет в одном событии, обратная запись=%s',
  async (reverse) => {
    const f = await profileFixture();
    try {
      const scope = await f.chat();
      f.deliver(scope);
      const message = await f.message(scope, alice, '1', 20);
      const events = [
        set('interest', 'Шахматы'),
        { kind: 'withdraw', interest: 'Шахматы' } as const,
      ];
      for (const event of reverse ? events.reverse() : events)
        await f.change(scope, alice, alice, message, event);
      expect(f.storage.profileFacts.searchInterests(scope, 'шахматы').matches).toEqual([]);
    } finally {
      await f.close();
    }
  },
);

test('отклонение связывает варианты вывода и допускает только более позднее явное свидетельство автора', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(50);
  const f = await profileFixture();
  try {
    const scope = await f.chat();
    const direct = await f.chat(alice, [alice]);
    f.deliver(scope);
    f.deliver(direct);
    const first = await f.message(scope, alice, '1', 20, false, 'Я увлекаюсь шахматами.');
    const alias = await f.message(scope, alice, '2', 21, false, 'Я играю в шахматы.');
    const running = await f.message(scope, alice, '3', 22, false, 'Я люблю бег.');
    const olderPending = await f.message(scope, alice, '4', 49, false, 'Моё хобби — шахматы.');
    expect(f.infer(scope, alice, first, set('interest', 'Шахматы'))).toBe('recorded');
    expect(f.infer(scope, alice, alias, set('hobby', 'игра в шахматы'))).toBe('recorded');
    expect(f.infer(scope, alice, running, set('interest', 'Бег'))).toBe('recorded');

    const store = profileCommandStore(f.storage);
    const list = store.open(alice, direct, scope, { scope: direct, messageId: '100', at: 50 }, 50)!;
    const [part] = store.parts(list, [{ first: 1, last: 3 }], 50)!;
    expect(store.confirm(list, 1, part!.sendId, '101', 50)).toBe(true);
    expect(
      store.edit(
        direct,
        alice,
        {
          messageId: '102',
          replyId: '101',
          position: 1,
          at: 50,
          change: { kind: 'reject' },
        },
        50,
      ),
    ).toBe('applied');
    expect(f.storage.profileFacts.read(scope, alice).facts.map(({ value }) => value)).toEqual([
      'Бег',
    ]);

    await f.reopen();
    const current = scopeFor(f.storage, group);
    clock.mockReturnValue(80);
    for (const id of [first, alias, olderPending]) {
      expect(f.infer(current, alice, id, set('hobbies', 'шахматами'))).toBe('blocked');
    }
    const atRejection = await f.message(current, alice, '5', 50, false, 'Я люблю шахматы.');
    const hearsay = await f.message(current, twin, '6', 52, false, 'Я люблю шахматы.');
    const implicit = await f.message(current, alice, '7', 53, false, 'Вчера смотрел турнир.');
    const quote = await f.message(current, alice, '8', 54, false, '«Я люблю шахматы».');
    for (const id of [atRejection, hearsay, implicit, quote])
      expect(f.infer(current, alice, id, set('interest', 'Шахматы'))).toBe('blocked');
    expect(f.infer(current, twin, hearsay, set('interest', 'Шахматы'))).toBe('recorded');

    const evidence = await f.message(current, alice, '9', 55, false, 'Шахматы — моё хобби.');
    expect(f.infer(current, alice, evidence, set('interest', 'Шахматы'))).toBe('recorded');
    expect(f.infer(current, alice, evidence, set('interest', 'Шахматы'))).toBe('duplicate');
    expect(f.storage.profileFacts.read(current, alice).facts).toMatchObject([
      { value: 'Бег', sourceKind: 'inferred' },
      { value: 'Шахматы', sourceKind: 'inferred' },
    ]);
    expect(personalDataStore(f.storage).export(current, alice, 80).facts).toMatchObject([
      { rejected_at: 50 },
      { rejected_at: 50 },
      { rejected_at: null },
      { rejected_at: null },
    ]);
  } finally {
    clock.mockRestore();
    await f.close();
  }
});
