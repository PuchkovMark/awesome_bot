import { expect, test } from 'vitest';
import { contextConfig } from '../src/core/context/config';
import { contextSeparator, estimateInput, staticMinimum } from '../src/core/context/budget';
import { validateContextStartup } from '../src/core/context/startup';
import { createContextBuilder } from '../src/core/context/index';
import { contextFixture } from './helpers/context';
const c = contextConfig({ modelContextTokens: 16000 });
test('конфигурация ограничивает общий ввод и резерв независимо от провайдера', () => {
  expect(c.inputBudgetTokens).toBe(8000);
  expect(Object.isFrozen(c)).toBe(true);
  for (const patch of [
    { modelContextTokens: 8000 },
    { historyPageSize: 257 },
    { maxHistoryMessages: 257 },
    { preparationTimeoutMs: NaN },
    { environmentReserveTokens: 8000 },
  ])
    expect(() => contextConfig({ ...c, ...patch })).toThrow('invalid_configuration');
});
test('оценка учитывает UTF-8 и сериализованные поля, а не длину русского текста', () => {
  expect(estimateInput('Я', [{ role: 'user', text: '😀' }])).toBe(128 + 2 + 32 + 4);
  expect(estimateInput('', [{ role: 'user', text: JSON.stringify('"\n') }])).toBeGreaterThan(
    estimateInput('', [{ role: 'user', text: '"\n' }]),
  );
});
test('нет fallback, начальная проверка различает отсутствие версии и размер статики', () => {
  expect(validateContextStartup(null, c)).toBe('missing_system_prompt');
  const version = {
    ref: { area: 'global', kind: 'system_prompt', key: 'base', version: 1 },
    text: 'x',
    createdAt: 0,
  } as const;
  const exact = { ...c, inputBudgetTokens: staticMinimum(version.text, c) };
  expect(validateContextStartup(version, exact)).toBe(null);
  expect(
    validateContextStartup(version, { ...exact, inputBudgetTokens: exact.inputBudgetTokens - 1 }),
  ).toBe('static_budget_too_small');
});
test('начальная проверка учитывает JSON-поле тега сверх действующего резерва обрамления', () => {
  const version = {
    ref: { area: 'global', kind: 'system_prompt', key: 'base', version: 1 },
    text: 'x',
    createdAt: 0,
  } as const;
  const previousMinimum =
    estimateInput(version.text + contextSeparator, [{ role: 'user', text: '' }]) +
    c.environmentReserveTokens +
    256;
  const addedBytes = Buffer.byteLength('"kind":"untrusted_chat_data",');
  expect(staticMinimum(version.text, c)).toBe(previousMinimum + addedBytes);
  expect(validateContextStartup(version, { ...c, inputBudgetTokens: previousMinimum })).toBe(
    'static_budget_too_small',
  );
});

test.each([true, false])(
  'последняя реплика входит ровно на границе, беседа=%s',
  async (isGroupChat) => {
    const fixture = await contextFixture();
    try {
      const older = await fixture.put('older', 'Старое "сообщение"\n😀');
      const latest = await fixture.put('latest', 'Реплика поновее\n«да»');
      const trigger = await fixture.put('trigger', 'Что было?');
      const work = fixture.work(trigger.id, isGroupChat);
      const complete = await fixture.builder.prepare(work);
      if (complete.kind !== 'ready') throw Error(complete.kind);
      expect(complete.metadata.messageIds).toEqual([older.id, latest.id, trigger.id]);
      const exactBudget = isGroupChat ? 1624 : 1756;
      expect(
        complete.metadata.estimatedTokens +
          c.environmentReserveTokens -
          complete.metadata.layerBytes.environment,
      ).toBe(exactBudget);

      const prepare = (inputBudgetTokens: number) =>
        createContextBuilder({
          ...fixture.options,
          config: { ...fixture.options.config, inputBudgetTokens },
        }).prepare(work);
      expect(await prepare(exactBudget)).toEqual(complete);
      const limited = await prepare(exactBudget - 1);
      if (limited.kind !== 'ready') throw Error(limited.kind);
      expect(limited.metadata.messageIds).toEqual([latest.id, trigger.id]);
      expect(limited.metadata.historyTruncated).toBe(true);
      expect(JSON.stringify(limited.input.messages)).not.toContain('Старое');
    } finally {
      await fixture.storage.close();
    }
  },
);

test('новое поле входит в точную стоимость и набор меток следует за выбранным окном', async () => {
  const f = await contextFixture();
  try {
    const older = await f.put('older', 'Первый вариант', { userId: 'vk:1', isGroupChat: true });
    const newer = await f.put('newer', 'Второй вариант', { userId: 'vk:2', isGroupChat: true });
    const current = await f.put('current', 'Что я предложил?', {
      userId: 'vk:2',
      isGroupChat: true,
    });
    const work = f.work(current.id, true);
    const ready = await f.builder.prepare(work);
    if (ready.kind !== 'ready') throw Error(ready.kind);
    expect(ready.metadata.messageIds).toEqual([older.id, newer.id, current.id]);
    expect([...ready.authorLabels!].sort()).toEqual(['u1', 'u2']);
    const cost = estimateInput(ready.input.system, ready.input.messages);
    const unlabeled = ready.input.messages.map((message) => ({
      ...message,
      text: message.text.replace(/,"authorLabel":"u[12]"/gu, ''),
    }));
    expect(cost - estimateInput(ready.input.system, unlabeled)).toBe(
      3 * Buffer.byteLength(',"authorLabel":"u1"'),
    );
    const budget = cost + c.environmentReserveTokens - ready.metadata.layerBytes.environment;
    const prepare = (inputBudgetTokens: number) =>
      createContextBuilder({
        ...f.options,
        config: { ...f.options.config, inputBudgetTokens },
      }).prepare(work);
    expect(await prepare(budget)).toEqual(ready);
    const smaller = await prepare(budget - 1);
    if (smaller.kind !== 'ready') throw Error(smaller.kind);
    expect(smaller.metadata.messageIds).toEqual([newer.id, current.id]);
    expect(smaller.metadata.historyTruncated).toBe(true);
    expect(smaller.authorLabels).toEqual(['u2']);
  } finally {
    await f.storage.close();
  }
});

test('допустимая форма обращения входит в точную стоимость текущей реплики', async () => {
  const f = await contextFixture();
  try {
    const trigger = await f.put('current', 'Текущая реплика', {
      userId: 'vk:2',
      isGroupChat: true,
    });
    const work = f.work(trigger.id, true);
    const name = 'Рысь "' + 'Я😀'.repeat(180);
    const prepare = (inputBudgetTokens: number) =>
      createContextBuilder({
        ...f.options,
        config: { ...f.options.config, inputBudgetTokens },
        addressForm: () => ({
          text: name,
          reference: {
            userId: 'vk:2',
            sourceTime: 100,
            revision: 1,
            isGroupChat: true,
          },
        }),
      }).prepare(work);
    const ready = await prepare(c.inputBudgetTokens);
    if (ready.kind !== 'ready') throw Error(ready.kind);
    expect(ready.addressPreference).toMatchObject({ userId: 'vk:2', revision: 1 });
    const messages = ready.input.messages;
    const budget =
      ready.metadata.estimatedTokens +
      c.environmentReserveTokens -
      ready.metadata.layerBytes.environment;
    expect(JSON.parse(messages.at(-1)!.text).current.addressForm).toBe(name);
    expect(await prepare(budget)).toEqual(ready);
    expect(await prepare(budget - 1)).toMatchObject({
      kind: 'failed',
      reason: 'current_message_too_large',
    });
  } finally {
    await f.storage.close();
  }
});

test('карточки расходуют остаток полного ввода и сохраняют ранее выданные схемы', async () => {
  const { estimateRequestInput } = await import('../src/core/context/budget');
  const { createParticipantCardComposer } = await import('../src/core/context/participant-cards');
  const { appendParticipantCards, serializeParticipantCard } =
    await import('../src/core/context/format');
  const source = {
    kind: 'untrusted_chat_data',
    history: [{ text: 'Прежняя реплика' }],
    reply: null,
    current: { text: 'Вопрос' },
  };
  const text = JSON.stringify(source);
  const request = {
    system: 'Статика',
    messages: [{ role: 'user' as const, text }],
    maxOutputTokens: 1024,
    sessionId: 'session',
    tools: [
      {
        name: 'lookup',
        description: 'Инструмент с описанием',
        parameters: { type: 'object' as const },
      },
    ],
  };
  const first = {
    fieldKey: 'тема',
    value: 'Опыт "⚡" и строка\nс фигурной скобкой }',
    sourceKind: 'self',
    reliability: 'confirmed',
  } as const;
  const second = { ...first, value: 'д'.repeat(120) };
  const exact = appendParticipantCards(text, [
    serializeParticipantCard({ author: 'Саша', authorLabel: 'u1', facts: [first] }),
  ]);
  const edge = estimateRequestInput({ ...request, messages: [{ role: 'user', text: exact }] });
  let reads = 0;
  const candidates = Array.from({ length: 23 }, (_, i) => ({
    id: i + 1,
    timestamp: i + 1,
    userId: `vk:${i + 1}` as const,
    authorLabel: `u${i + 1}`,
    author: 'Саша',
  }));
  const plan: import('../src/core/context/participant-cards').PreparedCards = {
    messageIndex: 0,
    modelContextTokens: edge + request.maxOutputTokens,
    candidates,
    read() {
      reads++;
      return {
        facts: [first, second].map((value, i) => ({
          value,
          reference: {} as import('../src/storage/participant-types').ContextCardFactReference,
          sourceIds: [100 + i],
        })),
      };
    },
    current: () => true,
  };
  const noRoom = createParticipantCardComposer(plan, estimateRequestInput(request))(request);
  expect(noRoom.request).toBe(request);
  expect(reads).toBe(0);
  const tooTight = createParticipantCardComposer(plan, edge - 1)(request);
  expect(tooTight.request).toBe(request);
  const exactRoom = createParticipantCardComposer(plan)(request);
  expect(exactRoom.used.map(({ owner, sourceIds }) => [owner, sourceIds])).toEqual([
    ['vk:1', [100]],
  ]);
  expect(exactRoom.request.tools).toBe(request.tools);
  expect(estimateRequestInput(exactRoom.request) + request.maxOutputTokens).toBe(
    plan.modelContextTokens,
  );
  const { participantCards, ...same } = JSON.parse(exactRoom.request.messages[0]!.text!);
  expect(same).toEqual(source);
  expect(participantCards).toEqual([{ author: 'Саша', authorLabel: 'u1', facts: [first] }]);
});
