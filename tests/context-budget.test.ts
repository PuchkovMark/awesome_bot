import { expect, test } from 'vitest';
import { contextConfig } from '../src/core/context/config';
import { estimateInput } from '../src/core/context/budget';
import { createContextBuilder } from '../src/core/context/index';
import { contextFixture } from './helpers/context';

const c = contextConfig({ modelContextTokens: 16000 });

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
