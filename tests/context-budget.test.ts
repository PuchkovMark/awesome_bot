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
