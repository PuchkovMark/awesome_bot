import { lifecycleBackend } from '../src/storage/lifecycle-store';
import { createAgentLoopQueue } from '../src/core/index';
import { tokenBudgetStore } from '../src/storage/token-budget-store';
import { expect, test, vi } from 'vitest';
import { createQuestionnaireProgress } from '../src/core/questionnaire/progress';
import {
  parseQuestionnaireAnswers,
  questionnaireAnswerHandler,
} from '../src/core/questionnaire/answer';
import { questionnaireProgressStore } from '../src/storage/questionnaire-progress-store';
import { questionnaireStore } from '../src/storage/questionnaire-store';
import { personalDataStore } from '../src/storage/personal-data-store';
import { questionnaireQuestions } from '../src/core/questionnaires/legacy-template';
import { assessQuestionnaire, questionnaireCases } from '../src/evals/questionnaire';
import type { QueueHandlerInput } from '../src/core/chat-queue/types';
import type { LlmClient } from '../src/llm/types';
import { alice, twin, group, neighbor, profileFixture } from './helpers/profile-fact-fixture';
import { openStorage, scopeFor } from './helpers/connection-scope';
import { seedBeforeQuestionnaires } from './helpers/questionnaire-upgrade';
import { storageFixture } from './helpers/storage-fixture';

const sample = questionnaireCases[0];
const output = '{"1":"Аня","2":null,"3":"походы и настольные игры"}';

test('редакции двух бесед закрепляются независимо, для лички редакции нет', async () => {
  const f = await profileFixture();
  try {
    const first = await f.chat(group);
    const second = await f.chat(neighbor);
    const direct = await f.chat(alice, [alice]);
    for (const scope of [first, second, direct]) f.deliver(scope);
    const progress = createQuestionnaireProgress(f.storage);
    const groupActor = progress.participant(first, alice);
    const before = groupActor.open(20)!;
    const other = progress.participant(second, alice).open(20)!;
    expect(before.attempt).not.toBe(other.attempt);
    expect(before.template.questions).toHaveLength(16);
    expect(other.template.questions).toEqual(before.template.questions);
    expect(progress.participant(direct, alice).open(20)).toBeNull();
    const templates = questionnaireStore(f.storage);
    expect(
      templates.recordPrompt(first, twin, before.template.ref.revision, {
        messageId: '800',
        userId: 'vk:-314',
        authorName: 'Пенёк',
        timestamp: 25,
        text: 'Редактор',
      }),
    ).toBe(true);
    expect(
      templates.replace(
        first,
        twin,
        { eventId: 801, eventAt: 26, receipt: '800', text: 'Новый вопрос?\nЕщё вопрос?' },
        26,
      ),
    ).toMatchObject({ status: 'applied' });
    expect(groupActor.pause(before.attempt)).toBe(true);
    expect(groupActor.resume(before.attempt, 27)?.template).toEqual(before.template);
    expect(
      progress
        .participant(first, twin)
        .open(27)
        ?.template.questions.map((q) => q.text),
    ).toEqual(['Новый вопрос?', 'Ещё вопрос?']);
    expect(progress.revision(second, alice)).toEqual(other.template);
    expect(progress.revision(direct, alice)).toBeNull();
  } finally {
    await f.close();
  }
});

test('у подключённой до редактора группы действуют 16 стартовых вопросов', async () => {
  const files = storageFixture();
  seedBeforeQuestionnaires(files.path, [group]);
  const storage = await openStorage(files.path);
  try {
    const scope = scopeFor(storage, group);
    expect(createQuestionnaireProgress(storage).revision(scope, alice)?.questions).toHaveLength(16);
  } finally {
    await storage.close();
    files.cleanup();
  }
});

test('служебная отмена привязана к событию и после перезапуска сохраняет новую попытку', async () => {
  const f = await profileFixture();
  try {
    const scope = await f.chat();
    f.deliver(scope);
    const progress = createQuestionnaireProgress(f.storage);
    const actor = progress.participant(scope, alice);
    const another = progress.participant(scope, twin);
    const event = (sequence: number) => ({ sequence, at: 20 + sequence });
    expect(actor.command('open', event(1), 25)).toMatchObject({ kind: 'showing' });
    expect(another.command('open', event(2), 25)).toMatchObject({ kind: 'showing' });
    expect(actor.command('pause', event(3), 25)).toEqual({ kind: 'paused' });
    expect(another.current(25)?.state).toBe('showing');
    expect(actor.command('open', event(4), 25)).toMatchObject({ kind: 'showing' });
    const former = actor.current(25)!.attempt;
    expect(actor.command('cancel', event(5), 26)).toEqual({ kind: 'cancelled' });
    expect(actor.command('open', event(6), 27)).toMatchObject({ kind: 'showing' });
    const current = actor.current(27)!.attempt;
    expect(current).not.toBe(former);
    await f.reopen();
    const restored = createQuestionnaireProgress(f.storage).participant(
      scopeFor(f.storage, group),
      alice,
    );
    expect(restored.command('cancel', event(5), 28)).toEqual({ kind: 'duplicate' });
    expect(restored.current(28)).toMatchObject({ attempt: current, state: 'showing' });
  } finally {
    await f.close();
  }
});

async function setup() {
  const f = await profileFixture();
  const scope = await f.chat();
  f.deliver(scope);
  const store = questionnaireProgressStore(f.storage);
  const actor = store.participant(scope, alice);
  const revision = {
    ref: { chatId: scope.chatId, generation: scope.generation, key: 'example', revision: 2 },
    questions: questionnaireQuestions(sample.questions),
  };
  const attempt = actor.open(100, () => revision)!;
  async function message(messageId: string, text = sample.text as string) {
    return (
      await f.storage.messages.append(scope, {
        chatId: group,
        userId: alice,
        role: 'user',
        authorName: 'Анна',
        messageId,
        text,
        timestamp: Date.now(),
      })
    ).id;
  }
  return { f, scope, store, actor, revision, attempt, message };
}

test('показ всей закреплённой редакции, ровный час, перезапуск и независимость участников', async () => {
  const { f, scope, actor, revision, attempt } = await setup();
  try {
    expect(
      actor.open(101, () => {
        throw Error('Повторный выбор редакции');
      }),
    ).toEqual(attempt);
    expect(actor.current(4_000_000)?.state).toBe('showing');
    const show = actor.takePresentation(100)!;
    expect(show.text).toBe(sample.questions.join('\n'));
    expect(actor.takePresentation(100)).toBeNull();
    expect(actor.deliveryFailed(show.presentation)).toBe(true);
    expect(actor.takePresentation(100)).toEqual(show);
    expect(actor.current(4_000_000)?.state).toBe('dispatching');
    expect(actor.shown(attempt.presentation, 100)).toBe(true);
    expect(actor.shown(attempt.presentation, 200)).toBe(false);
    expect(actor.current(3_600_099)?.state).toBe('active');
    expect(actor.current(3_600_100)?.state).toBe('paused');
    const other = questionnaireProgressStore(f.storage).participant(scope, twin);
    expect(other.open(101)?.template.ref.key).toBe('legacy-introduction');
    const next = await f.chat(neighbor);
    expect(questionnaireProgressStore(f.storage).participant(next, alice).current(103)).toBeNull();
    await f.reopen();
    const restarted = questionnaireProgressStore(f.storage).participant(
      scopeFor(f.storage, group),
      alice,
    );
    const resumed = restarted.resume(attempt.attempt, 4_000_000)!;
    expect(resumed.template).toEqual(revision);
    expect(restarted.shown(attempt.presentation, 4_000_001)).toBe(false);
    expect(restarted.takePresentation(4_000_002)?.presentation).toBe(resumed.presentation);
    expect(restarted.shown(resumed.presentation, 4_000_002)).toBe(true);
    expect(restarted.current(7_600_001)?.state).toBe('active');
    expect(restarted.pause(attempt.attempt)).toBe(true);
    expect(restarted.cancel(attempt.attempt)).toBe(true);
    expect(restarted.open(8_000_000)?.template.ref.key).toBe('legacy-introduction');
  } finally {
    await f.close();
  }
});

test('только один своевременный ответ завершается, экспорт, отмена, отзыв и повтор события', async () => {
  const { f, actor, attempt, message } = await setup();
  try {
    actor.takePresentation(100);
    actor.shown(attempt.presentation, 100);
    const id = await message('200'),
      second = await message('201');
    expect(actor.accept(attempt.attempt, id, 3_600_100)).toBe(false);
    expect(actor.accept(attempt.attempt, id, 3_600_099)).toBe(true);
    expect(actor.accept(attempt.attempt, second, 3_600_099)).toBe(false);
    expect(actor.accept(attempt.attempt, id, 3_600_099)).toBe(false);
    await f.reopen();
    const restored = questionnaireProgressStore(f.storage),
      current = scopeFor(f.storage, group);
    const answers = { '1': 'Аня', '3': 'походы и настольные игры' };
    expect(restored.finish(current, id, Date.now(), { '2': 'Москва' }, () => true)).toBe(false);
    expect(restored.finish(current, id, Date.now(), answers, () => true)).toBe(true);
    expect(restored.finish(current, id, Date.now(), answers, () => true)).toBe(false);
    const invitations = createQuestionnaireProgress(f.storage).invitations();
    expect(invitations.state(current, alice)).toBe('completed');
    expect(invitations.revision(current)?.questions).toHaveLength(16);
    const privacy = personalDataStore(f.storage);
    expect(privacy.export(current, alice, Date.now()).questionnaire).toMatchObject({
      questions: [
        { question: sample.questions[0], answer: 'Аня' },
        { question: sample.questions[1], answer: null },
        { question: sample.questions[2], answer: 'походы и настольные игры' },
      ],
    });
    expect(privacy.export(current, twin, Date.now()).questionnaire).toBeNull();
    const operation = privacy.requestDeletion(current, alice, 'delete-1', Date.now());
    expect(privacy.confirmDeletion(current, alice, operation.code, Date.now())).toBe(true);
    expect(restored.finish(current, id, Date.now(), answers, () => true)).toBe(false);
    expect(restored.participant(current, alice).current(Date.now())).toBeNull();
    expect(restored.owns(current, id)).toBe(false);
  } finally {
    await f.close();
  }
});

test('разбор на границе очереди, отказ квоты, повтор после сбоя и отзыв во время вызова', async () => {
  const { f, scope, store, actor, attempt, message } = await setup();
  try {
    const id = await message('250');
    actor.takePresentation(200);
    actor.shown(attempt.presentation, 200);
    actor.accept(attempt.attempt, id, 300);
    let quota = false;
    const recordUsage = vi.fn();
    const work: QueueHandlerInput = {
      scope,
      messageId: id,
      jobId: 123,
      recordTrace: vi.fn(),
      signal: new AbortController().signal,
      isCurrent: () => true,
      route: { kind: 'mention', mode: 'normal', isGroupChat: true },
      admitModelAttempt: () =>
        quota ? { recordUsage, cancelBeforeSend: vi.fn() } : 'quota_exhausted',
    };
    const client = vi
      .fn<LlmClient['complete']>()
      .mockResolvedValueOnce({ kind: 'error', code: 'network', message: 'offline' })
      .mockResolvedValue({ kind: 'complete', text: output, usage: { input: 10, output: 4 } });
    const run = questionnaireAnswerHandler({
      store,
      client: { complete: client },
      sessionId: () => 'session',
      maxOutputTokens: 100,
      inputLimit: 8000,
      modelName: 'test',
      disclosed: () => true,
    });
    expect(await run(work)).toMatchObject({ result: { kind: 'quota_exhausted' } });
    expect(client).not.toHaveBeenCalled();
    quota = true;
    expect(await run(work)).toMatchObject({ outcome: 'failed' });
    expect(await run(work)).toMatchObject({
      outcome: 'completed',
      result: { text: 'Спасибо! Анкета заполнена.' },
    });
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(await run(work)).toMatchObject({ outcome: 'interrupted' });
    expect(client).toHaveBeenCalledTimes(2);
    const request = client.mock.calls[0]![0];
    expect(request.tools).toBeUndefined();
    expect(request.messages).toHaveLength(1);
    expect(JSON.parse(request.messages[0]!.text!)).toEqual({
      questions: sample.questions.map((text, i) => ({ position: i + 1, text })),
      answer: sample.text,
    });
  } finally {
    await f.close();
  }
});

test('отмена, удаление или запрет профиля во время разбора исключают позднее завершение', async () => {
  for (const action of ['cancel', 'delete', 'disable']) {
    const { f, scope, store, actor, attempt, message } = await setup();
    try {
      const id = await message('90');
      actor.takePresentation(110);
      actor.shown(attempt.presentation, 110);
      expect(actor.accept(attempt.attempt, id, 120)).toBe(true);
      const privacy = personalDataStore(f.storage);
      if (action === 'cancel') actor.cancel(attempt.attempt);
      if (action === 'disable') privacy.disable(scope, alice, 130);
      if (action === 'delete') {
        const op = privacy.requestDeletion(scope, alice, 'remove', 130);
        privacy.confirmDeletion(scope, alice, op.code, 131);
      }
      expect(store.finish(scope, id, Date.now(), { '1': 'Аня' }, () => true)).toBe(false);
    } finally {
      await f.close();
    }
  }
});

test('контроль смысла обнаруживает реальную цитату у чужого поля, структурные ошибки отличимы от пропуска', async () => {
  const { f, revision } = await setup();
  try {
    expect(assessQuestionnaire(sample, output).outcome).toBe('passed');
    expect(
      assessQuestionnaire(sample, '{"1":null,"2":"Аня","3":"походы и настольные игры"}').outcome,
    ).toBe('failed');
    for (const invalid of [
      '{}',
      'null',
      '{"1":"Анна","2":null,"3":null}',
      '{"1":"Аня","2":null,"4":null}',
    ])
      expect(parseQuestionnaireAnswers(revision, sample.text, invalid)).toBeNull();
    expect(
      parseQuestionnaireAnswers(revision, 'Всё пропускаю', '{"1":null,"2":null,"3":null}'),
    ).toEqual({});
  } finally {
    await f.close();
  }
});

test('обычная очередь закрепляет вход вместе с заданием, учитывает бюджет и повторяет после отказа', async () => {
  const { f, scope, store, actor, attempt } = await setup();
  const now = Date.now();
  const client = vi
    .fn<LlmClient['complete']>()
    .mockResolvedValue({ kind: 'complete', text: output, usage: { input: 18, output: 12 } });
  const budget = tokenBudgetStore(f.storage);
  const run = questionnaireAnswerHandler({
    store,
    client: { complete: client },
    sessionId: () => 'questionnaire',
    maxOutputTokens: 200,
    inputLimit: 10000,
    modelName: 'synthetic',
    disclosed: () => true,
  });
  const queue = createAgentLoopQueue({
    storage: f.storage,
    tokenBudget: true,
    limits: {},
    tracing: { messageRetentionDays: 30 },
    modelName: 'synthetic',
    client: { complete: client },
    questionnaireAnswer: run,
    prepare: async () => {
      throw Error('Обычный контекст вызван для анкеты');
    },
  });
  async function submit(messageId: string) {
    const { admission } = await queue.admitRouted(
      scope,
      {
        chatId: group,
        userId: alice,
        role: 'user',
        authorName: 'Анна',
        messageId,
        text: sample.text,
        timestamp: now,
      },
      () => ({ reason: 'mention', route: { kind: 'mention', mode: 'normal', isGroupChat: true } }),
    );
    return admission;
  }
  try {
    actor.takePresentation(now - 100);
    actor.shown(attempt.presentation, now - 100);
    await queue.start();
    budget.update(scope, true, { total: 1 }, now);
    const first = await submit('100');
    expect(first.status).toBe('queued');
    if (first.status !== 'queued') throw Error('Ожидалось задание');
    await vi.waitFor(async () =>
      expect((await f.storage.queue.get(scope, first.jobId))?.state).toBe('terminal'),
    );
    expect(client).not.toHaveBeenCalled();
    expect(actor.current(Date.now())?.state).toBe('active');
    budget.update(scope, true, { total: 50000 }, Date.now());
    const second = await submit('101');
    if (second.status !== 'queued') throw Error('Ожидалось повторное задание');
    await vi.waitFor(async () =>
      expect((await f.storage.queue.get(scope, second.jobId))?.outcome).toBe('completed'),
    );
    expect(actor.current(Date.now())?.state).toBe('completed');
    expect(client).toHaveBeenCalledTimes(1);
    expect((await submit('101')).status).toBe('duplicate');
    expect(budget.read(scope, true, Date.now()).total.confirmed).toBe(30n);
  } finally {
    await queue.stop();
    await f.close();
  }
});

test('сброс беседы во время разбора исключает запись в новое подключение и сохраняет чужую беседу', async () => {
  const { f, scope, store, actor, attempt, message } = await setup();
  try {
    const other = await f.chat(neighbor);
    f.deliver(other);
    const neighborActor = store.participant(other, alice);
    expect(neighborActor.open(110)).toBeTruthy();
    const id = await message('251');
    actor.takePresentation(120);
    actor.shown(attempt.presentation, 125);
    expect(actor.accept(attempt.attempt, id, 130)).toBe(true);
    const life = lifecycleBackend(f.storage);
    life.ownerDelete(life.begin(group), scope.generation);
    const fresh = scopeFor(f.storage, group);
    expect(store.participant(fresh, alice).current(140)).toBeNull();
    expect(store.finish(fresh, id, 140, {}, () => true)).toBe(false);
    expect(store.owns(fresh, id)).toBe(false);
    expect(neighborActor.current(140)?.state).toBe('showing');
  } finally {
    await f.close();
  }
});
