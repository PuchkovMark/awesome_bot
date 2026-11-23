import { expect, test } from 'vitest';
import { openConnection } from '../src/storage/connection';
import { personalDataStore } from '../src/storage/personal-data-store';
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
