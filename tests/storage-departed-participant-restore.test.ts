import Database from 'better-sqlite3';
import { expect, test, vi } from 'vitest';
import type { ConnectionScope } from '../src/contracts/index';
import { lifecycleBackend } from '../src/storage/lifecycle-store';
import { departureGraceMs } from '../src/storage/participant-departures';
import { participantRegistryStore } from '../src/storage/participant-registry';
import { reconcileStagedPersonalData } from '../src/storage/personal-data-restore';
import { personalDataStore } from '../src/storage/personal-data-store';
import { tokenBudgetStore } from '../src/storage/token-budget-store';
import { openStorage, scopeFor } from './helpers/connection-scope';
import { alice, group, neighbor, profileFixture, set } from './helpers/profile-fact-fixture';

const start = Date.UTC(2026, 10, 23, 12);
const leftAt = start + 2000;
const returnedAt = leftAt + 1000;
const deadline = leftAt + departureGraceMs;

async function setup() {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  const f = await profileFixture();
  const scope = await f.chat();
  const other = await f.chat(neighbor, [alice]);
  for (const target of [scope, other]) {
    f.deliver(target);
    const input = await f.message(target, alice, '11', start + 1000);
    const result = await f.change(
      target,
      alice,
      alice,
      input,
      set('city', target === scope ? 'Старый профиль' : 'Соседний профиль'),
    );
    expect(result).toMatchObject({ value: 'recorded' });
  }
  const source = new Database(f.path);
  source.pragma('foreign_keys=ON');
  const response = await f.storage.messages.append(scope, {
    chatId: scope.chatId,
    userId: 'vk:-314',
    role: 'assistant',
    authorName: 'Пенёк',
    messageId: '12',
    timestamp: start + 1100,
    text: 'СводкаПрофиля049',
  });
  source.transaction(() =>
    personalDataStore(f.storage).recordAnswerSources(source, scope, '12', [], [alice]),
  )();
  const path = f.path + '.staged';
  return {
    f,
    scope,
    source,
    response,
    path,
    event(change: 'left' | 'joined', time: number) {
      clock.mockReturnValue(time);
      return participantRegistryStore(f.storage).observe(scope, {
        kind: 'membership',
        chatId: group,
        actorId: alice,
        subjectId: alice,
        change,
        timestamp: time,
        eventId: change + time,
      });
    },
    backup: () => source.backup(path),
    reconcile: (time: number) => {
      clock.mockReturnValue(time);
      const staged = new Database(path);
      const recent = new Database(f.path, { readonly: true });
      staged.pragma('foreign_keys=ON');
      try {
        reconcileStagedPersonalData(staged, recent, time);
        reconcileStagedPersonalData(staged, recent, time);
        expect(staged.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      } finally {
        staged.close();
        recent.close();
      }
    },
    async close() {
      source.close();
      await f.close();
      clock.mockRestore();
    },
  };
}

test.each(['до ухода', 'во время срока'] as const)(
  'сверка копии %s подтверждает ранний возврат и защищает от повтора ухода',
  async (saved) => {
    const s = await setup();
    try {
      if (saved === 'до ухода') await s.backup();
      expect(s.event('left', leftAt)).toBe(true);
      if (saved === 'во время срока') await s.backup();
      expect(s.event('joined', returnedAt)).toBe(true);
      s.reconcile(returnedAt + 1);
      const restored = await openStorage(s.path);
      try {
        const scope = scopeFor(restored, group);
        expect(restored.profileFacts.read(scope, alice).facts[0]?.value).toBe('Старый профиль');
        expect((await restored.messages.get(scope, s.response.id))?.text).toBe('СводкаПрофиля049');
        expect(
          restored.profileFacts.read(scopeFor(restored, neighbor), alice).facts[0]?.value,
        ).toBe('Соседний профиль');
        const registry = participantRegistryStore(restored);
        expect(registry.departure(scope, alice)).toMatchObject({ departedAt: leftAt, returnedAt });
        expect(
          registry.observe(scope, {
            kind: 'membership',
            chatId: group,
            change: 'left',
            eventId: 'left' + leftAt,
            actorId: alice,
            subjectId: alice,
            timestamp: leftAt,
          }),
        ).toBe(false);
      } finally {
        await restored.close();
      }
    } finally {
      await s.close();
    }
  },
);

test.each(['достигнута граница', 'начата новая анкета и профиль', 'личное удаление'] as const)(
  'сверка копии внутри срока не возвращает прежние сведения — %s',
  async (outcome) => {
    const s = await setup();
    try {
      s.event('left', leftAt);
      await s.backup();
      let at = deadline;
      if (outcome === 'начата новая анкета и профиль') {
        s.event('joined', deadline);
        const input = await s.f.message(s.scope, alice, '13', deadline + 1);
        await s.f.change(s.scope, alice, alice, input, set('city', 'Новый профиль'));
        at += 1;
      } else if (outcome === 'личное удаление') {
        const privacy = personalDataStore(s.f.storage);
        const request = privacy.requestDeletion(s.scope, alice, 'личное удаление', returnedAt);
        expect(privacy.confirmDeletion(s.scope, alice, request.code, returnedAt + 1)).toBe(true);
        at = returnedAt + 1;
      }
      s.reconcile(at);
      const restored = await openStorage(s.path);
      try {
        const scope = scopeFor(restored, group);
        expect(restored.profileFacts.read(scope, alice).facts).toEqual([]);
        expect(await restored.messages.get(scope, s.response.id)).toBeNull();
        expect(
          restored.profileFacts.read(scopeFor(restored, neighbor), alice).facts[0]?.value,
        ).toBe('Соседний профиль');
        expect(
          (await restored.messages.list(scope, { limit: 10 })).some(
            (msg) => msg.messageId === '11',
          ),
        ).toBe(outcome !== 'личное удаление');
        if (outcome === 'начата новая анкета и профиль')
          expect(s.f.storage.profileFacts.read(s.scope, alice).facts[0]?.value).toBe(
            'Новый профиль',
          );
      } finally {
        await restored.close();
      }
    } finally {
      await s.close();
    }
  },
);

test('при недостатке свежих сведений копия закрыта до принятой полной сверки', async () => {
  const s = await setup();
  try {
    await s.backup();
    s.source
      .prepare(
        "UPDATE chat_participants SET status='unknown',status_observed_at=NULL WHERE chat_id=? AND user_id=?",
      )
      .run(group, alice);
    s.reconcile(start + 1600);
    const restored = await openStorage(s.path);
    try {
      const scope: ConnectionScope = scopeFor(restored, group);
      expect(restored.profileFacts.read(scope, alice).facts).toEqual([]);
      expect(await restored.messages.get(scope, s.response.id)).toBeNull();
      expect(personalDataStore(restored).export(scope, alice, Date.now()).profile).toBeNull();
      expect(restored.profileFacts.read(scopeFor(restored, neighbor), alice).facts[0]?.value).toBe(
        'Соседний профиль',
      );
      const roster = tokenBudgetStore(restored);
      const at = start + 1700;
      expect(
        roster.finishObservation(
          scope,
          roster.beginObservation(scope, at),
          { complete: false },
          at,
        ),
      ).toBe(false);
      expect(restored.profileFacts.read(scope, alice).facts).toEqual([]);
      expect(
        roster.finishObservation(
          scope,
          roster.beginObservation(scope, at + 1),
          { complete: true, people: 1, members: [{ userId: alice, role: 'member' }] },
          at + 1,
        ),
      ).toBe(true);
      expect(restored.profileFacts.read(scope, alice).facts[0]?.value).toBe('Старый профиль');
      expect(await restored.messages.get(scope, s.response.id)).not.toBeNull();
    } finally {
      await restored.close();
    }
  } finally {
    await s.close();
  }
});

test('сверка отказывает копии другого поколения до внесения изменений', async () => {
  const s = await setup();
  try {
    await s.backup();
    const life = lifecycleBackend(s.f.storage);
    life.ownerDecision(life.begin(group), 'new');
    expect(() => s.reconcile(start + 1500)).toThrow('invalid_input');
    const staged = new Database(s.path, { readonly: true });
    try {
      expect(staged.prepare('SELECT count(*) FROM participant_departures').pluck().get()).toBe(0);
      expect(staged.prepare('SELECT count(*) FROM participant_profiles').pluck().get()).toBe(2);
    } finally {
      staged.close();
    }
  } finally {
    await s.close();
  }
});
