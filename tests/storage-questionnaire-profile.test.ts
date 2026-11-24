import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import type { ConnectionScope, UserId } from '../src/contracts/index';
import { lifecycleBackend } from '../src/storage/lifecycle-store';
import { personalDataStore } from '../src/storage/personal-data-store';
import { reconcileStagedPersonalData } from '../src/storage/personal-data-restore';
import { departureGraceMs } from '../src/storage/participant-departures';
import { participantRegistryStore } from '../src/storage/participant-registry';
import { profileCommandStore } from '../src/storage/profile-command-store';
import { selectOwnProfile } from '../src/storage/profile-fact-selection';
import { questionnairePresentationStore } from '../src/storage/questionnaire-presentation-store';
import { questionnaireProgressStore } from '../src/storage/questionnaire-progress-store';
import { questionnaireStore } from '../src/storage/questionnaire-store';
import { questionnaireQuestions } from '../src/core/questionnaires/legacy-template';
import { openStorage, scopeFor } from './helpers/connection-scope';
import { alice, group, neighbor, profileFixture, twin } from './helpers/profile-fact-fixture';

type Fixture = Awaited<ReturnType<typeof profileFixture>>;
const question = 'Чем увлекаетесь?';
const answers = { '1': 'Шахматы', '3': 'Го' };

function revision(scope: ConnectionScope) {
  return {
    ref: { chatId: scope.chatId, generation: scope.generation, key: 'example', revision: 2 },
    questions: questionnaireQuestions([question, 'Что пропустить?', question]),
  };
}

async function pending(f: Fixture, scope: ConnectionScope, user: UserId, messageId: string) {
  const store = questionnaireProgressStore(f.storage);
  const actor = store.participant(scope, user);
  const { attempt, presentation } = actor.open(100, () => revision(scope))!;
  actor.takePresentation(100);
  actor.shown(presentation, 100);
  const id = await f.message(scope, user, messageId, 120, false, 'Шахматы и Го');
  expect(actor.accept(attempt, id, 120)).toBe(true);
  return { store, actor, id };
}

function own(f: Fixture, scope: ConnectionScope, user: UserId = alice) {
  return lifecycleBackend(f.storage).transaction(scope, (db) =>
    selectOwnProfile(db, scope, user, Date.now()),
  );
}

test('позиции одинаковых вопросов, источник и изоляция беседы и лички сохраняются после перезапуска', async () => {
  const f = await profileFixture();
  try {
    const scope = await f.chat();
    const direct = await f.chat(alice, [alice]);
    f.deliver(scope);
    f.deliver(direct);
    const { store, id } = await pending(f, scope, alice, '200');
    const templates = questionnaireStore(f.storage);
    templates.recordPrompt(scope, twin, 1, {
      messageId: '201',
      userId: 'vk:-314',
      authorName: 'Пенёк',
      timestamp: 125,
      text: 'Редактор',
    });
    expect(
      templates.replace(scope, twin, { receipt: '201', eventId: 202, text: 'Новый вопрос?' }, 126),
    ).toMatchObject({ status: 'applied' });
    expect(store.finish(scope, id, 130, answers, () => true)).toBe(true);
    expect(store.finish(scope, id, 131, answers, () => true)).toBe(false);
    const privateAttempt = await pending(f, direct, alice, '203');
    expect(store.finish(direct, privateAttempt.id, 130, { '3': 'Го' }, () => true)).toBe(true);
    await f.reopen();

    const restored = scopeFor(f.storage, group);
    const facts = own(f, restored);
    expect(facts).toMatchObject([
      {
        question,
        value: 'Шахматы',
        sourceKind: 'self',
        visibility: 'chat',
        questionnaireOpen: false,
      },
      { question, value: 'Го', sourceKind: 'self', visibility: 'chat', questionnaireOpen: false },
    ]);
    expect(facts[0]?.fieldKey).not.toBe(facts[1]?.fieldKey);
    expect(own(f, scopeFor(f.storage, alice))).toMatchObject([
      { question, value: 'Го', sourceKind: 'self', visibility: 'bot' },
    ]);
    expect(f.storage.profileFacts.read(restored, alice).facts).toEqual([]);
    expect(f.storage.profileFacts.cardFacts(restored, alice)).toEqual([]);
    const origins = lifecycleBackend(f.storage).transaction(restored, (db) =>
      db
        .prepare(
          `SELECT f.source_user_id,f.source_message_id,q.template_revision,q.position FROM
        questionnaire_answer_facts q JOIN profile_facts f ON f.id=q.fact_id WHERE f.chat_id=? ORDER BY q.position`,
        )
        .all(group),
    );
    expect(origins).toEqual([
      { source_user_id: alice, source_message_id: '200', template_revision: 2, position: 1 },
      { source_user_id: alice, source_message_id: '200', template_revision: 2, position: 3 },
    ]);
  } finally {
    await f.close();
  }
});

test('ошибка записи позиции откатывает всё завершение; пропуск всех вопросов создаёт только состояние анкеты', async () => {
  const f = await profileFixture();
  try {
    const scope = await f.chat();
    f.deliver(scope);
    const { store, actor, id } = await pending(f, scope, alice, '200');
    const life = lifecycleBackend(f.storage);
    life.transaction(scope, (db) =>
      db.exec(`CREATE TRIGGER fail_answer BEFORE INSERT ON questionnaire_answer_facts
      WHEN NEW.position=3 BEGIN SELECT raise(ABORT,'test'); END`),
    );
    expect(() => store.finish(scope, id, 130, answers, () => true)).toThrow();
    expect(actor.current(131)?.state).toBe('processing');
    expect(own(f, scope)).toEqual([]);
    expect(
      life.transaction(scope, (db) => db.prepare('SELECT * FROM questionnaire_access').all()),
    ).toEqual([]);
    life.transaction(scope, (db) => db.exec('DROP TRIGGER fail_answer'));
    expect(store.finish(scope, id, 132, {}, () => true)).toBe(true);
    expect(actor.current(133)?.state).toBe('completed');
    expect(own(f, scope)).toEqual([]);
  } finally {
    await f.close();
  }
});

test('обновление переносит только проверяемые цитаты действующего профиля и оставляет доступ закрытым', async () => {
  const f = await profileFixture();
  try {
    const scope = await f.chat();
    f.deliver(scope);
    const first = await pending(f, scope, alice, '200');
    const second = await pending(f, scope, twin, '201');
    const life = lifecycleBackend(f.storage);
    // Восстанавливаем схему предыдущей версии и заполняем данные, существовавшие до переноса.
    life.transaction(scope, (db) => {
      db.exec(`DROP TABLE questionnaire_presentations;
        DROP TABLE questionnaire_answer_facts;
        DROP TABLE questionnaire_access;
        DROP INDEX questionnaire_progress_attempt;
        DELETE FROM schema_migrations WHERE version>=45;
        UPDATE messages SET purpose='conversation' WHERE id IN (SELECT message_id FROM questionnaire_inputs);`);
      db.prepare(
        "UPDATE questionnaire_progress SET state='completed',answers=? WHERE source_id=?",
      ).run(JSON.stringify({ ...answers, '2': 'Отсутствующая цитата' }), first.id);
      db.prepare(
        "UPDATE questionnaire_progress SET state='completed',answers=? WHERE source_id=?",
      ).run(JSON.stringify(answers), second.id);
      db.prepare('DELETE FROM messages WHERE id=?').run(second.id);
    });
    await f.reopen();
    const restored = scopeFor(f.storage, group);
    expect(own(f, restored).map(({ value }) => value)).toEqual(['Шахматы', 'Го']);
    expect(own(f, restored, twin)).toEqual([]);
    expect(f.storage.profileFacts.read(restored, alice).facts).toEqual([]);
    expect(
      personalDataStore(f.storage).export(restored, alice, Date.now()).questionnaire,
    ).toMatchObject({ questions: [{ answer: 'Шахматы' }, {}, { answer: 'Го' }] });
    const access = lifecycleBackend(f.storage).transaction(restored, (db) =>
      db
        .prepare('SELECT prompt_delivered_at,decision FROM questionnaire_access ORDER BY user_id')
        .all(),
    );
    expect(access).toEqual([
      { prompt_delivered_at: null, decision: null },
      { prompt_delivered_at: null, decision: null },
    ]);
  } finally {
    await f.close();
  }
});

test('личные правки анкеты и подтверждённое удаление сохраняются при восстановлении копии', async () => {
  const f = await profileFixture();
  const backup = f.path + '.backup';
  try {
    const target = await f.chat();
    const direct = await f.chat(alice, [alice]);
    const other = await f.chat(neighbor);
    for (const scope of [target, direct, other]) {
      f.deliver(scope);
      const { store, id } = await pending(f, scope, alice, '200');
      expect(store.finish(scope, id, 130, answers, () => true)).toBe(true);
    }
    const db = new Database(f.path, { readonly: true });
    try {
      await db.backup(backup);
      const lists = profileCommandStore(f.storage);
      const list = lists.open(
        alice,
        direct,
        target,
        { scope: direct, messageId: '300', at: 140 },
        140,
      )!;
      const [part] = lists.parts(list, [{ first: 1, last: 2 }], 140)!;
      expect(lists.confirm(list, 1, part!.sendId, '301', 140)).toBe(true);
      const edit = (
        messageId: string,
        position: number,
        change: { kind: 'hide' } | { kind: 'correct'; value: string },
      ) => lists.edit(direct, alice, { messageId, position, change, at: 150, replyId: '301' }, 150);
      expect(edit('302', 2, { kind: 'hide' })).toBe('applied');
      expect(edit('303', 1, { kind: 'correct', value: 'Шашки' })).toBe('applied');
      const presentations = questionnairePresentationStore(f.storage);
      const decision = presentations.decide(target, alice, true, {
        sequence: 201,
        at: 151,
        receipt: null,
      });
      if (decision.kind !== 'approved') throw new Error('Согласие не сохранилось');
      presentations.confirmPart(target, decision.grant, {
        messageId: '202',
        userId: 'vk:-314',
        authorName: 'Пенёк',
        text: 'Шашки',
        timestamp: 151,
      });
      presentations.finish(target, decision.grant, 'delivered');
      const privacy = personalDataStore(f.storage);
      const current = privacy.export(target, alice, 151);
      expect(current.questionnaire?.presentation).toEqual({
        state: 'delivered',
        confirmedParts: 1,
      });
      expect(current.questionnaire?.questions.map(({ answer }) => answer)).toEqual([
        'Шашки',
        null,
        'Го',
      ]);
      expect(current.facts).toMatchObject([
        { value: 'Го', visibility: 'bot' },
        { value: 'Шашки', visibility: 'chat' },
      ]);
      expect(current.facts).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ value: 'Шахматы' })]),
      );
      const stage = new Database(backup);
      stage.pragma('foreign_keys=ON');
      try {
        reconcileStagedPersonalData(stage, db, 151);
        const copy = await openStorage(backup);
        try {
          const restored = personalDataStore(copy).export(scopeFor(copy, group), alice, 151);
          expect(restored.questionnaire).toEqual(current.questionnaire);
          expect(restored.facts).toEqual(current.facts);
        } finally {
          await copy.close();
        }
        const operation = privacy.requestDeletion(target, alice, 'delete-067', 152);
        expect(privacy.confirmDeletion(target, alice, operation.code, 153)).toBe(true);
        reconcileStagedPersonalData(stage, db, 154);
        expect(
          stage.prepare('SELECT * FROM questionnaire_answer_facts WHERE chat_id=?').all(group),
        ).toEqual([]);
        expect(
          stage.prepare('SELECT * FROM questionnaire_access WHERE chat_id=?').all(group),
        ).toEqual([]);
        expect(
          stage.prepare('SELECT * FROM questionnaire_presentations WHERE chat_id=?').all(group),
        ).toEqual([]);
        expect(stage.prepare('SELECT * FROM profile_facts WHERE chat_id=?').all(group)).toEqual([]);
        expect(stage.pragma('foreign_key_check')).toEqual([]);
      } finally {
        stage.close();
      }
      for (const scope of [direct, other])
        expect(
          privacy.export(scope, alice, 154).questionnaire?.questions.map(({ answer }) => answer),
        ).toEqual(['Шахматы', null, 'Го']);
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});

test('уход закрывает анкету, ранний возврат сохраняет ответы, очистка по сроку удаляет их', async () => {
  const f = await profileFixture();
  try {
    const scope = await f.chat();
    f.deliver(scope);
    const { store, id } = await pending(f, scope, alice, '200');
    expect(store.finish(scope, id, 130, answers, () => true)).toBe(true);
    const registry = participantRegistryStore(f.storage);
    const privacy = personalDataStore(f.storage);
    const event = (change: 'left' | 'joined', timestamp: number) =>
      registry.observe(scope, {
        kind: 'membership',
        chatId: scope.chatId,
        change,
        timestamp,
        eventId: String(timestamp),
        subjectId: alice,
        actorId: alice,
      });
    const leftAt = Date.now() - 1000;
    expect(event('left', leftAt)).toBe(true);
    expect(own(f, scope)).toEqual([]);
    expect(privacy.export(scope, alice, leftAt + 1).questionnaire?.questions[0]?.answer).toBe(
      'Шахматы',
    );
    expect(event('joined', leftAt + 2)).toBe(true);
    expect(own(f, scope)).toHaveLength(2);
    expect(event('left', leftAt + 3)).toBe(true);
    expect(registry.purgeDeparted(leftAt + 3 + departureGraceMs)).toBe(1);
    expect(privacy.export(scope, alice, leftAt + 3 + departureGraceMs).questionnaire).toBeNull();
    expect(
      lifecycleBackend(f.storage).transaction(scope, (db) =>
        db.prepare('SELECT * FROM questionnaire_access').all(),
      ),
    ).toEqual([]);
  } finally {
    await f.close();
  }
});
