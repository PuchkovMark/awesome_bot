import { expect, test } from 'vitest';
import { contextConfig } from '../src/core/context/config';
import { contextSeparator, estimateInput, staticMinimum } from '../src/core/context/budget';
import { validateContextStartup } from '../src/core/context/startup';

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
