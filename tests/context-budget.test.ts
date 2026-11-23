import { expect, test, vi } from 'vitest';
import { contextConfig } from '../src/core/context/config';
import { estimateInput, estimateRequestInput } from '../src/core/context/budget';
import { composePassport, type PreparedPassport } from '../src/core/context/passport';
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

const groupInput = {
  kind: 'untrusted_chat_data',
  history: [{ text: 'История.' }],
  reply: { text: 'Цитата.' },
  current: { text: 'Можно ли публиковать рекламу, и что значит «маяк»?' },
  participantCards: [{ author: 'Саша', facts: [{ fieldKey: 'city', value: 'Томск' }] }],
};
const request = {
  system: 'Проверенная инструкция.',
  messages: [{ role: 'user' as const, text: JSON.stringify(groupInput) }],
  maxOutputTokens: 1024,
  sessionId: 'session',
  tools: [
    { name: 'history_search', description: 'Поиск', parameters: { type: 'object' as const } },
  ],
};
const requestCost = estimateRequestInput(request);
const plan = (
  entries: PreparedPassport['entries'],
  flags: Partial<PreparedPassport> = {},
): PreparedPassport => ({
  entries,
  messageIndex: 0,
  modelContextTokens: c.modelContextTokens,
  inputBudgetTokens: c.inputBudgetTokens,
  current: () => true,
  ...flags,
});

function passportCost(chatPassport: Record<string, string>) {
  return (
    estimateRequestInput({
      ...request,
      messages: [
        { ...request.messages[0]!, text: JSON.stringify({ ...groupInput, chatPassport }) },
      ],
    }) - requestCost
  );
}

test('паспорт укладывается ровно в десять процентов и в полный запрос со схемами и резервом', () => {
  const rules = 'Реклама по согласованию. "Оговорка"\nСимволы }😀\\';
  const extra = passportCost({ rules });
  const entries = [{ section: 'rules', revision: 3, text: rules }] as const;
  const edge = {
    inputBudgetTokens: extra * 10,
    modelContextTokens: requestCost + extra + request.maxOutputTokens,
  };
  const result = composePassport(plan(entries, edge), request);
  expect(result.used).toEqual([{ section: 'rules', revision: 3 }]);
  expect(result.estimatedTokens).toBe(extra);
  expect(estimateRequestInput(result.request) + request.maxOutputTokens).toBe(
    edge.modelContextTokens,
  );
  expect(result.request.tools).toBe(request.tools);
  expect(JSON.parse(result.request.messages[0]!.text!)).toEqual({
    ...groupInput,
    chatPassport: { rules },
  });

  for (const limit of [
    { ...edge, inputBudgetTokens: edge.inputBudgetTokens - 1 },
    { ...edge, modelContextTokens: edge.modelContextTokens - 1 },
  ])
    expect(composePassport(plan(entries, limit), request).request).toBe(request);
  expect(composePassport(plan(entries, edge), request, requestCost + extra - 1).request).toBe(
    request,
  );
});

test('предел 1024 сохраняет целый раздел и позволяет проверить следующий при переполнении', () => {
  const rules = 'r'.repeat(1024 - passportCost({ rules: '' }));
  expect(passportCost({ rules })).toBe(1024);
  const large = { section: 'rules', revision: 7, text: rules } as const;
  const glossary = 'Маяк означает место сбора.';
  const short = { section: 'glossary', revision: 4, text: glossary } as const;
  const config = { inputBudgetTokens: 12_000 };
  expect(composePassport(plan([large, short], config), request).estimatedTokens).toBe(1024);
  const overflow = { ...large, text: large.text + 'S' };
  expect(composePassport(plan([overflow], config), request).request).toBe(request);
  const smaller = composePassport(plan([overflow, short], config), request);
  expect(smaller.used).toEqual([{ section: 'glossary', revision: 4 }]);
  expect(JSON.parse(smaller.request.messages[0]!.text!)).toEqual({
    ...groupInput,
    chatPassport: { glossary },
  });
});

test('нейтральное обращение сохраняет запрос и пропускает чтение паспорта', async () => {
  const f = await contextFixture();
  try {
    const reply = await f.put('neutral', 'Как дела?');
    const work = f.work(reply.id, true);
    const read = vi.fn(() => [
      { section: 'rules' as const, revision: 1, text: 'Локальное правило.' },
    ]);
    const builder = createContextBuilder({ ...f.options, passport: { read, current: () => true } });
    expect(await builder.prepare(work)).toEqual(await f.builder.prepare(work));
    expect(read).not.toHaveBeenCalled();
    const question = await f.put('relevant', 'Что значит «маяк» и можно ли размещать рекламу?');
    const scoped = await builder.prepare(f.work(question.id, true));
    if (scoped.kind !== 'ready') throw Error(scoped.kind);
    expect(scoped.passport?.entries).toEqual([
      { section: 'rules', revision: 1, text: 'Локальное правило.' },
    ]);
    expect(read).toHaveBeenCalledOnce();
    const privateInput = await builder.prepare(f.work(question.id, false));
    expect(privateInput).not.toHaveProperty('passport');
    expect(read).toHaveBeenCalledOnce();
  } finally {
    await f.storage.close();
  }
});
