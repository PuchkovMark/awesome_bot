import Database from 'better-sqlite3';
import { expect, test, vi } from 'vitest';
import type { ConnectionScope, UserId } from '../src/contracts/index';
import { createQuestionnaireProgress } from '../src/core/questionnaire/progress';
import { addressPreferenceStore } from '../src/storage/address-preference-store';
import { applyHistoryRetention } from '../src/storage/history-retention-store';
import { departureGraceMs, purgeDepartedProfiles } from '../src/storage/participant-departures';
import { participantRegistryStore } from '../src/storage/participant-registry';
import { personalDataStore } from '../src/storage/personal-data-store';
import { profileCommandStore } from '../src/storage/profile-command-store';
import { questionnaireProgressStore } from '../src/storage/questionnaire-progress-store';
import type { Storage } from '../src/storage/types';
import { openStorage, scopeFor } from './helpers/connection-scope';
import {
  admin,
  alice,
  group,
  neighbor,
  profileFixture,
  set,
  twin,
} from './helpers/profile-fact-fixture';

const start = Date.UTC(2026, 10, 23, 12);
const departure = start + 500;
const deadline = departure + departureGraceMs;
const invitationEntry = { action: () => 'Открыть', state: () => 'available' as const };

function observe(
  storage: Storage,
  scope: ConnectionScope,
  user: UserId,
  change: 'left' | 'removed' | 'joined',
  timestamp: number,
) {
  return participantRegistryStore(storage).observe(scope, {
    kind: 'membership',
    chatId: scope.chatId,
    subjectId: user,
    actorId: change === 'removed' ? admin : user,
    change,
    timestamp,
    eventId: [user, change, timestamp].join(':'),
  });
}

async function answer(storage: Storage, scope: ConnectionScope, key: string, text: string) {
  return (
    await storage.messages.append(scope, {
      chatId: scope.chatId,
      userId: 'vk:-314',
      role: 'assistant',
      authorName: 'Пенёк',
      messageId: key,
      timestamp: start + 100,
      text,
    })
  ).id;
}

test('срок скрывает и очищает профиль, анкету и зависимые ответы порциями, обычная история сохраняется', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  const f = await profileFixture();
  const db = new Database(f.path);
  db.pragma('foreign_keys=ON');
  try {
    const scope = await f.chat();
    const privateScope = await f.chat(alice, [alice]);
    const other = await f.chat(neighbor, [alice]);
    for (const target of [scope, privateScope, other]) f.deliver(target);
    applyHistoryRetention(db, 2 * departureGraceMs, start);
    const ordinary = await f.message(scope, alice, '20', start + 110);
    const unrelated = await f.message(scope, twin, '21', start + 120);
    const otherOrigin = await f.message(other, alice, '20', start + 110);
    await f.change(scope, alice, alice, ordinary, set('city', 'Казань'));
    await f.change(scope, twin, twin, unrelated, set('city', 'Омск'));
    await f.change(other, alice, alice, otherOrigin, set('city', 'Пермь'));
    const preference = addressPreferenceStore(f.storage);
    expect(
      preference.change(
        scope,
        alice,
        { sequence: 20, at: start + 110, isGroupChat: true },
        { kind: 'set', form: 'Синица' },
        () => true,
      ),
    ).toBe('changed');
    expect(
      preference.change(
        privateScope,
        alice,
        { sequence: 20, at: start + 110, isGroupChat: false },
        { kind: 'set', form: 'Личные данные' },
        () => true,
      ),
    ).toBe('changed');

    const questionnaire = questionnaireProgressStore(f.storage);
    const participant = questionnaire.participant(scope, alice);
    const opened = participant.open(start + 50)!;
    const presentation = participant.takePresentation(start + 51)!;
    expect(participant.shown(presentation.presentation, start + 52)).toBe(true);
    expect(participant.accept(opened.attempt, ordinary, start + 111)).toBe(true);
    expect(
      questionnaire.finish(scope, ordinary, start + 112, { '1': 'Синтетическая' }, () => true),
    ).toBe(true);
    const invitations = createQuestionnaireProgress(f.storage).invitations(invitationEntry);
    expect(invitations.state(scope, alice)).toBe('completed');
    const commands = profileCommandStore(f.storage);
    const list = commands.open(
      alice,
      privateScope,
      scope,
      { scope, messageId: '100', at: start + 300 },
      start + 300,
    )!;
    expect(list.facts[0]?.value).toBe('Казань');

    const root = await answer(f.storage, scope, '30', 'Сведения из профиля');
    const mixed = await answer(f.storage, scope, '31', 'Производнаязаключение');
    const independent = await answer(f.storage, scope, '32', 'Обычный ответ');
    const ambiguous = await answer(f.storage, scope, '33', 'Старый ответ без источников');
    const otherAnswer = await answer(f.storage, other, '30', 'Ответ соседней беседы');
    const privacy = personalDataStore(f.storage);
    db.transaction(() => {
      privacy.recordAnswerSources(db, scope, '30', [ordinary], [alice]);
      privacy.recordAnswerSources(db, scope, '31', [root, unrelated]);
      privacy.recordAnswerSources(db, scope, '32', [ordinary]);
      privacy.recordAnswerSources(db, other, '30', [otherOrigin], [alice]);
    })();
    const stored = (id: number) => db.prepare('SELECT 1 FROM messages WHERE id=?').get(id);
    const visible = (id: number) =>
      db.prepare('SELECT 1 FROM personal_visible_messages WHERE id=?').get(id);
    expect(visible(root)).toBeDefined();
    expect(visible(mixed)).toBeDefined();
    expect(visible(ambiguous)).toBeDefined();

    clock.mockReturnValue(start + 350);
    observe(f.storage, scope, alice, 'left', start + 350);
    expect(participant.current(Date.now())).toBeNull();
    expect(invitations.state(scope, alice)).toBe('unavailable');
    expect(visible(root)).toBeUndefined();
    expect(visible(mixed)).toBeUndefined();
    expect(visible(ambiguous)).toBeUndefined();
    expect(commands.current(list, Date.now())).toBe(false);
    expect(await f.storage.contextMessages.search(scope, 'Производнаязаключение', 5, 500)).toEqual(
      [],
    );
    clock.mockReturnValue(start + 400);
    observe(f.storage, scope, alice, 'joined', start + 400);
    expect(invitations.state(scope, alice)).toBe('completed');
    expect(visible(root)).toBeDefined();
    expect(visible(mixed)).toBeDefined();
    expect(visible(ambiguous)).toBeDefined();
    expect(commands.current(list, Date.now())).toBe(false);

    clock.mockReturnValue(departure + 1);
    observe(f.storage, scope, alice, 'removed', departure);
    observe(f.storage, scope, twin, 'left', departure + 1);
    expect(privacy.export(scope, alice, deadline - 1).profile).not.toBeNull();
    expect(privacy.export(scope, alice, deadline).profile).toBeNull();
    expect(privacy.export(scope, alice, deadline).messages).toHaveLength(1);
    expect(participantRegistryStore(f.storage).purgeDeparted(deadline - 1)).toBe(0);
    expect(db.transaction(() => purgeDepartedProfiles(db, deadline, 1)).immediate()).toBe(1);
    expect(stored(root)).toBeUndefined();
    expect(stored(mixed)).toBeUndefined();
    expect(stored(ambiguous)).toBeDefined();
    expect(visible(ambiguous)).toBeUndefined();
    expect(visible(independent)).toBeDefined();
    expect(visible(ordinary)).toBeDefined();
    expect(visible(otherAnswer)).toBeDefined();

    db.exec(
      "CREATE TRIGGER purge_failure BEFORE DELETE ON profile_facts WHEN OLD.user_id='vk:42' BEGIN SELECT raise(ABORT,'test'); END",
    );
    await f.reopen();
    const persisted = participantRegistryStore(f.storage);
    const restored = scopeFor(f.storage, group);
    expect(() => persisted.purgeDeparted(deadline + 1)).toThrow('operation_failed');
    expect(persisted.departure(restored, twin)?.purgedAt).toBeNull();
    expect(persisted.departure(restored, alice)?.purgedAt).toBe(deadline);
    db.exec('DROP TRIGGER purge_failure');
    expect(persisted.purgeDeparted(deadline + 1)).toBe(1);
    expect(persisted.purgeDeparted(deadline + 1)).toBe(0);
    expect(db.prepare('SELECT * FROM questionnaire_inputs').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM questionnaire_progress').all()).toEqual([]);
    expect(db.prepare('SELECT user_id FROM profile_command_lists').all()).toEqual([]);
    expect(
      db
        .prepare(
          'SELECT platform_message_id FROM history_deleted_inputs WHERE chat_id=? ORDER BY platform_message_id',
        )
        .pluck()
        .all(group),
    ).toEqual(['30', '31']);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(f.storage.profileFacts.read(scopeFor(f.storage, neighbor), alice).facts[0]?.value).toBe(
      'Пермь',
    );
    expect(
      addressPreferenceStore(f.storage).resolve(
        scopeFor(f.storage, alice),
        alice,
        Date.now(),
        false,
      )?.text,
    ).toBe('Личные данные');
    clock.mockReturnValue(deadline + 2);
    observe(f.storage, restored, alice, 'joined', deadline + 2);
    expect(
      db
        .prepare(
          'SELECT disputed,retired FROM departed_profile_answers WHERE chat_id=? AND user_id=? AND answer_id=?',
        )
        .get(group, alice, ambiguous),
    ).toEqual({ disputed: 1, retired: 1 });
    expect(
      createQuestionnaireProgress(f.storage).invitations(invitationEntry).state(restored, alice),
    ).toBe('available');
  } finally {
    db.close();
    await f.close();
    clock.mockRestore();
  }
});

test.each(['возврат первым', 'очистка первой'] as const)(
  'на границе срока другое соединение с БД не удаляет новый профиль — %s',
  async (order) => {
    const f = await profileFixture();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    const maintenance = await openStorage(f.path);
    try {
      const scope = await f.chat();
      f.deliver(scope);
      const prior = await f.message(scope, alice, '20', start + 100);
      await f.change(scope, alice, alice, prior, set('city', 'Старая Казань'));
      observe(f.storage, scope, alice, 'left', departure);
      clock.mockReturnValue(deadline);
      const purge = () => participantRegistryStore(maintenance).purgeDeparted(deadline);
      if (order === 'очистка первой') expect(purge()).toBe(1);
      observe(f.storage, scope, alice, 'joined', deadline);
      expect(f.storage.profileFacts.read(scope, alice).facts).toEqual([]);
      expect(f.infer(scope, alice, prior, set('city', 'Повтор из старой истории'))).toBe('blocked');
      clock.mockReturnValue(deadline + 1);
      const fresh = await f.message(scope, alice, '21', deadline + 1);
      await f.change(scope, alice, alice, fresh, set('city', 'Новая Пермь'));
      expect(purge()).toBe(0);
      expect(f.storage.profileFacts.read(scope, alice).facts[0]?.value).toBe('Новая Пермь');
      expect(await f.storage.messages.get(scope, prior)).not.toBeNull();
    } finally {
      await maintenance.close();
      await f.close();
      clock.mockRestore();
    }
  },
);

test('личное удаление в пределах срока приоритетно, отказ другого участника остаётся после очистки', async () => {
  const f = await profileFixture();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  try {
    const scope = await f.chat();
    f.deliver(scope);
    const origin = await f.message(scope, alice, '20', start + 100);
    await f.change(scope, alice, alice, origin, set('city', 'Москва'));
    const privacy = personalDataStore(f.storage);
    privacy.disable(scope, twin, start + 200);
    observe(f.storage, scope, alice, 'left', departure);
    observe(f.storage, scope, twin, 'left', departure);
    const pending = privacy.requestDeletion(scope, alice, 'личка', departure + 1);
    expect(privacy.confirmDeletion(scope, alice, pending.code, departure + 2)).toBe(true);
    expect(await f.storage.messages.get(scope, origin)).toBeNull();
    clock.mockReturnValue(departure + 3);
    observe(f.storage, scope, alice, 'joined', departure + 3);
    expect(f.storage.profileFacts.read(scope, alice).facts).toEqual([]);
    participantRegistryStore(f.storage).purgeDeparted(deadline);
    clock.mockReturnValue(deadline + 1);
    observe(f.storage, scope, twin, 'joined', deadline + 1);
    expect(privacy.profileAllowed(scope, twin, deadline + 2)).toBe(false);
    expect(privacy.profileAllowed(scope, alice, deadline + 2)).toBe(false);
  } finally {
    await f.close();
    clock.mockRestore();
  }
});
