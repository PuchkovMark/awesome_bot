import { tokenBudgetStore } from '../src/storage/token-budget-store';
import { expect, test } from 'vitest';
import type { LlmToolCall } from '../src/llm/types';
import { estimateRequestInput } from '../src/core/context/budget';
import { noticeTemplate } from '../src/storage/notice-types';
import {
  answer,
  chat,
  fixture,
  mention,
  peer,
  until,
} from './helpers/application-response-fixture';

type App = Awaited<ReturnType<typeof fixture>>;
function call(name: string, id: string, params: unknown): LlmToolCall {
  return { name, id, arguments: JSON.stringify(params) };
}
function calls(...calls: LlmToolCall[]) {
  return { kind: 'tool_calls' as const, calls, text: null, usage: { input: 1, output: 1 } };
}
async function seed(app: App, lastText = 'Маяк вечером') {
  const append = (id: string, text: string, time: number) =>
    app.storage.messages.append(app.scope, {
      chatId: chat,
      userId: 'vk:73',
      role: 'user',
      authorName: 'Саша',
      isGroupChat: true,
      messageId: id,
      timestamp: time,
      text,
    });
  const first = await append('first', 'Маяк утром', app.start - 8000);
  const last = await append('last', lastText, app.start - 4000);
  // Обе строки находятся за пределами недавнего окна.
  for (let n = 0; n < 24; n++)
    await append('divider' + n, 'Переписка '.repeat(110), app.start - 2000);
  tokenBudgetStore(app.storage).update(app.scope, true, { total: 250000 }, app.start);
  return { first: first.id, last: last.id };
}
const lookup = call('history_search', 'read', { query: 'Маяк', limit: 1 });

test('после поиска четырём участникам хватает автоматического бюджета для продолжения', async () => {
  const spent = 49_317;
  const previousLimit = 60_000;
  const oldRemaining = previousLimit - spent;
  const startAt = Date.UTC(2026, 10, 25, 22, 52, 44);
  const searchUsage = { input: 700, output: 10 };
  const replyUsage = { input: 901, output: 27 };
  const historyText = 'Маяк вечером. ' + 'Запись о маршруте. '.repeat(55);
  const replyText = 'Встреча у маяка вечером.';

  async function run(override: number | null) {
    const app = await fixture({ startAt, greetings: { members: [41, 42, 73, 74] } });
    try {
      const store = tokenBudgetStore(app.storage);
      const group = app.scope;
      const budget = () => store.read(group, true, startAt);
      await until(() => expect(budget().people).toBe(4));
      await seed(app, historyText);
      store.update(group, true, { total: override }, startAt);
      expect(
        store.reserve(
          group,
          true,
          { key: 'previous', purpose: 'direct', input: spent, output: 0 },
          startAt,
        ),
      ).toBe(true);
      expect(store.reconcile(group, 'previous', { input: spent, output: 0 })).toBe(true);
      const limit = override ?? 500_000;
      expect(budget().total).toMatchObject({
        limit,
        confirmed: 49_317n,
        remaining: limit - spent,
        reserved: 0n,
      });

      app.submit('Показать расход', 73, undefined, 73);
      await until(() =>
        expect(
          app.sends.some(
            ({ peer_id, text }) =>
              peer_id === 73 &&
              text.includes(
                chat +
                  ' — подтверждено 49317 из ' +
                  limit +
                  ', удержано 0, попыток без полного usage 0.',
              ),
          ),
        ).toBe(true),
      );
      expect(app.complete).not.toHaveBeenCalled();

      const probe = { key: 'probe', purpose: 'direct', input: 11_000, output: 1000 } as const;
      expect(store.reserve(group, true, probe, startAt)).toBe(override === null);
      if (override === null) {
        expect(budget().total).toMatchObject({ remaining: 438_683, reserved: 12_000n });
        await store.meter(group, probe.key).cancelBeforeSend();
        expect(budget().total).toMatchObject({ remaining: 450_683, reserved: 0n });
      }

      app.complete
        .mockResolvedValueOnce({ ...calls(lookup), usage: searchUsage })
        .mockResolvedValueOnce({ ...answer, text: replyText, usage: replyUsage });
      const id = app.submit(mention);
      const trace = (await app.trace(id)).payload;
      expect(trace.tools).toContainEqual(
        expect.objectContaining({ name: 'history_search', outcome: 'success' }),
      );
      expect(trace.publication.status).toBe('delivered');
      const reply = app.sends
        .filter((row) => row.peer_id === peer && row.reply_message?.conversation_message_id === id)
        .map(({ text }) => text);
      const requests = app.complete.mock.calls.map(([request]) => request);
      const [initial, continued] = requests;
      expect(initial?.tools?.map(({ name }) => name)).toContain('history_search');
      expect(JSON.stringify(initial?.messages)).not.toContain('Маяк');
      const charges = [searchUsage];
      if (override === null) {
        expect(requests).toHaveLength(2);
        expect(trace.resultKind).toBe('complete');
        const result = continued?.messages.find((message) => message.role === 'tool');
        expect(JSON.parse(result?.text ?? '{}')).toMatchObject({
          found: 2,
          shown: 1,
          messages: [{ text: expect.stringContaining('Маяк вечером.') }],
        });
        expect(reply).toEqual([replyText]);
        charges.push(replyUsage);
      } else {
        expect(requests).toHaveLength(1);
        expect(trace.resultKind).toBe('token_budget_exhausted');
        expect(reply).toEqual([noticeTemplate('token_budget_exhausted')]);
      }
      expect(
        app.db
          .prepare(
            `SELECT input_reserve AS inputReserve,output_reserve AS outputReserve,
            input_tokens AS input,output_tokens AS output
            FROM token_budget_attempts WHERE chat_id=? AND generation=? AND attempt_key LIKE 'job:%'
            ORDER BY rowid`,
          )
          .all(group.chatId, group.generation),
      ).toEqual(
        requests.map((request, i) => ({
          inputReserve: estimateRequestInput(request),
          outputReserve: request.maxOutputTokens,
          ...charges[i],
        })),
      );
      const paid = charges.reduce((sum, { input, output }) => sum + input + output, spent);
      expect(budget().total).toMatchObject({
        limit,
        confirmed: BigInt(paid),
        reserved: 0n,
        incompleteAttempts: 0,
      });
      return requests.map((request) => estimateRequestInput(request) + request.maxOutputTokens);
    } finally {
      await app.close();
    }
  }

  const [first, afterSearch] = await run(null);
  expect(first).toBeLessThanOrEqual(oldRemaining);
  expect(afterSearch).toBeGreaterThan(oldRemaining - searchUsage.input - searchUsage.output);
  expect(afterSearch).toBeLessThanOrEqual(450_683 - searchUsage.input - searchUsage.output);
  expect(await run(previousLimit)).toEqual([first]);
}, 10_000);

test('поиск, чтение периода и поиск по показанной метке работают через штатный маршрут', async () => {
  const app = await fixture();
  try {
    const { last } = await seed(app);
    const range = {
      from: new Date(app.start - 9000).toISOString(),
      to: new Date(app.start - 3000).toISOString(),
    };
    app.complete
      .mockImplementationOnce(async (req) => {
        expect(req.tools?.map((t) => t.name)).toContain('history_period');
        expect(JSON.stringify(req.messages)).not.toContain('Маяк');
        return calls(
          lookup,
          call('history_period', 'range', range),
          call('history_search', 'unknown', { author: 'u9000' }),
        );
      })
      .mockImplementationOnce(async (req) => {
        const results = req.messages
          .filter((m) => m.role === 'tool')
          .map((m) => JSON.parse(m.text));
        expect(results[0]).toMatchObject({
          found: 2,
          shown: 1,
          messages: [{ text: 'Маяк вечером' }],
        });
        expect(results[1].messages.map((r: { text: string }) => r.text)).toEqual([
          'Маяк утром',
          'Маяк вечером',
        ]);
        expect(results[2].clarify).toBeTruthy();
        return calls(
          call('history_search', 'author', {
            author: results[0].messages[0].authorLabel,
            query: 'Маяк',
          }),
        );
      })
      .mockResolvedValueOnce({ kind: 'error', code: 'server', message: 'synthetic' })
      .mockImplementationOnce(async (req) => {
        expect(JSON.parse(req.messages.filter((m) => m.role === 'tool').at(-1)!.text).found).toBe(
          2,
        );
        expect(estimateRequestInput(req) + req.maxOutputTokens).toBeLessThanOrEqual(16000);
        return answer;
      });
    const id = app.submit(mention);
    await app.published(id);
    expect(app.complete.mock.settledResults.filter((r) => r.type === 'rejected')).toEqual([]);
    expect(app.complete).toHaveBeenCalledTimes(4);
    const trace = await app.trace(id);
    expect(JSON.stringify(trace.payload)).not.toContain('Маяк');
    expect(
      app.db
        .prepare('SELECT count(*) FROM personal_answer_sources WHERE source_id=?')
        .pluck()
        .get(last),
    ).toBeGreaterThan(0);
  } finally {
    await app.close();
  }
});

test.each(['модель', 'первая часть', 'вторая часть', 'только счётчик', 'чужая строка'] as const)(
  'актуальность выборки — %s',
  async (stage) => {
    const hold = stage === 'первая часть' || stage === 'вторая часть';
    const app = await fixture({ hold });
    const pending = Promise.withResolvers<void>();
    try {
      const { first, last } = await seed(app);
      let unrelatedId: number | undefined;
      if (stage === 'чужая строка') {
        const neighbor = await app.connectGroup(2000000888);
        unrelatedId = (
          await app.storage.messages.append(neighbor, {
            chatId: neighbor.chatId,
            userId: 'vk:73',
            authorName: 'Саша',
            role: 'user',
            timestamp: app.start,
            text: 'Маяк',
            messageId: 'foreign',
          })
        ).id;
      }
      const text = stage === 'вторая часть' ? 'Длинная реплика. '.repeat(400) : answer.text;
      app.complete.mockResolvedValueOnce(calls(lookup)).mockImplementationOnce(async (req) => {
        expect(JSON.parse(req.messages.filter((m) => m.role === 'tool')[0]!.text).found).toBe(2);
        await pending.promise;
        return { ...answer, text };
      });
      const id = app.submit(mention);
      await until(() => expect(app.complete).toHaveBeenCalledTimes(2));
      if (hold) {
        pending.resolve();
        await until(() => expect(app.holds).toHaveLength(1));
        if (stage === 'вторая часть') {
          app.holds[0]!.release();
          await until(() => expect(app.holds).toHaveLength(2));
        }
      }
      if (stage === 'чужая строка')
        expect(app.db.prepare('DELETE FROM messages WHERE id=?').run(unrelatedId).changes).toBe(1);
      else
        app.db
          .prepare('DELETE FROM messages WHERE id=?')
          .run(stage === 'только счётчик' ? first : last);
      pending.resolve();
      if (hold) {
        const part = app.holds.at(-1)!;
        part.release();
        await part.finished;
        await app.trace(id);
      } else if (stage === 'чужая строка') await app.published(id);
      else await app.interrupted(id);
      expect(app.sends.filter((row) => row.peer_id === peer)).toHaveLength(
        stage === 'вторая часть' || stage === 'чужая строка' ? 1 : 0,
      );
    } finally {
      pending.resolve();
      await app.close();
    }
  },
);

test.each([false, true])(
  'помощник читает историю в собственном бюджете, удаление источника %s',
  async (remove) => {
    const app = await fixture();
    try {
      const { last } = await seed(app, 'Маяк вечером "🌊" '.repeat(300));
      app.complete.mockImplementation(async (req) => {
        const tool = req.messages.find((m) => m.role === 'tool');
        if (req.system.includes('Выполни указанную подзадачу')) {
          expect(estimateRequestInput(req)).toBeLessThanOrEqual(2560);
          if (!tool) return calls(lookup);
          const material = JSON.parse(tool.text);
          expect(JSON.parse(material.text)).toMatchObject({
            found: 2,
            shown: 1,
            messages: [{ truncated: true }],
          });
          expect(Buffer.byteLength(JSON.stringify(tool)) + 32).toBeLessThanOrEqual(2048);
          if (remove) app.db.prepare('DELETE FROM messages WHERE id=?').run(last);
          return {
            ...answer,
            text: JSON.stringify({
              answer: 'Вечером обсудили маяк.',
              citations: [material.ref],
              gaps: [],
            }),
          };
        }
        if (!tool)
          return calls(
            call('delegate', 'delegate-history', {
              goal: 'Найди маяк',
              sources: [],
              tools: ['history_search'],
            }),
          );
        expect(JSON.parse(tool.text)).toMatchObject({
          status: 'complete',
          answer: 'Вечером обсудили маяк.',
        });
        return answer;
      });
      const id = app.submit(mention);
      if (remove) {
        await app.interrupted(id);
        expect(app.sends).toHaveLength(0);
      } else await app.published(id);
      expect(app.complete.mock.settledResults.filter((r) => r.type === 'rejected')).toEqual([]);
      expect(app.complete).toHaveBeenCalledTimes(remove ? 3 : 4);
    } finally {
      await app.close();
    }
  },
);

test('личный диалог видит только свой журнал', async () => {
  const app = await fixture({ profileNotice: 'Уведомление для лички.' });
  try {
    await seed(app);
    app.at(1000);
    app.submit('/анкета', 41, undefined, 41);
    await until(() =>
      expect(
        app.sends.some((s) => s.peer_id === 41 && s.text.includes('Уведомление для лички.')),
      ).toBe(true),
    );
    app.at(2000);
    app.complete.mockResolvedValueOnce(calls(lookup)).mockResolvedValueOnce(answer);
    app.submit('Где мой маяк?', 41, undefined, 41);
    await until(() =>
      expect(app.sends.some((s) => s.peer_id === 41 && s.text === answer.text)).toBe(true),
    );
    const result = app.complete.mock.calls[1]![0].messages.find((m) => m.role === 'tool')!;
    expect(JSON.parse(result.text)).toMatchObject({
      found: 1,
      messages: [{ text: 'Где мой маяк?' }],
    });
  } finally {
    await app.close();
  }
});
