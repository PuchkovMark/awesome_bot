import { writeFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { fixture, chat, mention } from './helpers/application-response-fixture';
import { completion, toolCall } from './helpers/llm-http';
import { createLlmClient } from '../src/llm/client';
import type { LlmFetch, LlmResult } from '../src/llm/types';
import { tokenBudgetStore } from '../src/storage/token-budget-store';

const auxiliaryModel = 'claude-haiku-5-5';
const requestLimit = 12;
const source = 'Маяк: зал Б, 18:10.';
const question =
  'В каком зале и во сколько начинается встреча «Маяк»? Успеет ли к началу Борис, который может до 19:00?';
const systemPrompt =
  'Это оценка на синтетическом журнале. Ответь кратко, в одном или двух предложениях. ' +
  'Если доступен delegate, для расписания вызови delegate с sources: [], ' +
  'tools: ["history_search"] и goal: «Найди Маяк до 2026-11-23T12:00:00Z, limit 1». ' +
  'Можешь дать второму помощнику извлечь ограничение Бориса из current. ' +
  'Сведи результаты в один ответ. Если инструменты недоступны, ' +
  'назови известное ограничение Бориса и сообщи, что расписание неизвестно.';

type Attempt = {
  role: 'main' | 'helper';
  model: string;
  durationMs: number;
  outcome: LlmResult['kind'] | 'pending';
  error?: string;
  input: number | null;
  output: number | null;
  tools: readonly string[];
  receivedSource: boolean;
};

type Report = Awaited<ReturnType<typeof compare>>;

function hasSchedule(text: string) {
  return (
    /зал[ае]?\s*(?::\s*)?[«"„]?Б(?![а-яё])/iu.test(text.replaceAll('*', '')) &&
    text.includes('18:10')
  );
}

async function compare(options: {
  mainModel: string;
  apiKey: string;
  fetch: LlmFetch;
  signal: AbortSignal;
  requestLimit?: number;
}) {
  let requests = 0;
  const rows = [];
  for (const mode of ['direct', 'delegate'] as const) {
    const attempts: Attempt[] = [];
    let citedSchedule = false;
    const scheduleRefs = new Set<string>();
    const modelClient = (role: Attempt['role'], model: string) => {
      const client = createLlmClient(
        { provider: 'opencode', apiKey: options.apiKey, model },
        {
          timeoutMs: 30_000,
          fetch: (url, init) => {
            if (options.signal.aborted || requests >= (options.requestLimit ?? requestLimit))
              throw new Error('Окончен бюджет прогона.');
            if (JSON.parse(String(init.body)).model !== model)
              throw new Error('Неверная модель в запросе.');
            requests++;
            return options.fetch(url, {
              ...init,
              signal: AbortSignal.any([options.signal, ...(init.signal ? [init.signal] : [])]),
            });
          },
        },
      );
      return {
        async complete(input: Parameters<typeof client.complete>[0]) {
          const toolMessages = input.messages.filter((message) => message.role === 'tool');
          let receivedSource = false;
          if (role === 'helper')
            for (const { text } of toolMessages) {
              if (!text.includes(source)) continue;
              scheduleRefs.add(JSON.parse(text).ref);
              receivedSource = true;
            }
          const attempt: Attempt = {
            role,
            model,
            durationMs: 0,
            outcome: 'pending',
            input: null,
            output: null,
            tools: [],
            receivedSource,
          };
          if (role === 'main')
            citedSchedule ||= toolMessages.some(({ text }) => {
              const result = JSON.parse(text);
              return (
                result.status === 'complete' &&
                hasSchedule(result.answer) &&
                result.citations.some((ref: string) => scheduleRefs.has(ref))
              );
            });
          attempts.push(attempt);
          const start = performance.now();
          const tools =
            role === 'helper'
              ? (input.tools ?? [])
              : mode === 'direct'
                ? []
                : (input.tools ?? []).filter(({ name }) => name === 'delegate');
          const result = await client.complete({ ...input, tools });
          attempt.durationMs = Math.round(performance.now() - start);
          attempt.outcome = result.kind;
          if (result.kind === 'error') attempt.error = result.code;
          else {
            attempt.input = result.usage.input;
            attempt.output = result.usage.output;
          }
          if (result.kind === 'tool_calls') attempt.tools = result.calls.map(({ name }) => name);
          return result;
        },
      };
    };
    const app = await fixture({
      model: options.mainModel,
      auxiliaryModel,
      systemPrompt,
      modelClients: {
        client: modelClient('main', options.mainModel),
        auxiliaryClient: modelClient('helper', auxiliaryModel),
      },
    });
    try {
      tokenBudgetStore(app.storage).update(app.scope, true, { total: 100_000 }, app.start);
      const append = (id: string, text: string, timestamp: number) =>
        app.storage.messages.append(app.scope, {
          chatId: chat,
          userId: 'vk:73',
          role: 'user',
          authorName: 'Саша',
          isGroupChat: true,
          messageId: id,
          timestamp,
          text,
        });
      await append('schedule', source, app.start - 8000);
      for (let n = 0; n < 24; n++)
        await append('divider' + n, 'Переписка '.repeat(110), app.start - 4000);

      const start = performance.now();
      const id = app.submit(mention + ' ' + question);
      const trace = await app.trace(id, 125_000);
      const elapsedMs = Math.round(performance.now() - start);
      rows.push({
        mode,
        elapsedMs,
        answer: app.sends[0]?.text ?? '',
        publications: app.sends.length,
        outcome: trace.payload.resultKind,
        citedSchedule,
        attempts,
      });
    } finally {
      await app.close();
    }
  }
  return { mainModel: options.mainModel, auxiliaryModel, requests, rows };
}

function verify(report: Report) {
  const [direct, delegated] = report.rows;
  expect(direct).toMatchObject({
    publications: 1,
    attempts: [{ role: 'main', model: report.mainModel, outcome: 'complete' }],
  });
  expect(direct!.answer).toContain('19:00');
  expect(direct!.answer).not.toContain('18:10');
  expect(delegated).toMatchObject({ publications: 1, citedSchedule: true });
  expect(hasSchedule(delegated!.answer)).toBe(true);
  expect(delegated!.answer).toContain('19:00');
  expect(delegated!.attempts.at(-1)).toMatchObject({
    role: 'main',
    model: report.mainModel,
    outcome: 'complete',
  });
  const branches = delegated!.attempts.filter(({ role }) => role === 'helper');
  expect(branches.every(({ model }) => model === auxiliaryModel)).toBe(true);
  expect(branches.some(({ tools }) => tools.includes('history_search'))).toBe(true);
  expect(branches).toContainEqual(
    expect.objectContaining({ receivedSource: true, outcome: 'complete' }),
  );
  expect(report.requests).toBe(report.rows.flatMap(({ attempts }) => attempts).length);
}

test('отчёт сравнения связывает транспортные попытки с моделями и прочитанным источником', async () => {
  const answer = 'Зал Б в 18:10. Борис успевает, поскольку может до 19:00.';
  const response = (text: string) =>
    Response.json({ ...completion(text), usage: { prompt_tokens: 31, completion_tokens: 7 } });
  const calls = (call: ReturnType<typeof toolCall>) =>
    Response.json(completion(null, 'tool_calls', { tool_calls: [call] }));
  const steps = [
    () => response('Борис может до 19:00. Расписание неизвестно.'),
    () =>
      calls(
        toolCall(
          'a',
          'delegate',
          '{"goal":"Найди расписание","sources":[],"tools":["history_search"]}',
        ),
      ),
    () =>
      calls(
        toolCall(
          'toolu_01JUSFt2JVddGSV3H5cba5pF',
          'history_search',
          '{"query":"Маяк","to":"2026-11-23T12:00:00Z","limit":1}',
        ),
      ),
    () =>
      response(
        JSON.stringify({
          answer: source,
          citations: ['read:toolu_01JUSFt2JVddGSV3H5cba5pF'],
          gaps: [],
        }),
      ),
    () => response(answer),
  ];
  const models: string[] = [];
  const report = await compare({
    mainModel: 'synthetic-main',
    apiKey: 'synthetic-key',
    signal: AbortSignal.timeout(10_000),
    async fetch(_url, init) {
      const { model } = JSON.parse(String(init.body));
      return steps[models.push(model) - 1]!();
    },
  });
  verify(report);
  const attempts = report.rows.flatMap(({ attempts }) => attempts);
  expect(attempts.map(({ model }) => model)).toEqual(models);
  expect(attempts.at(-1)).toMatchObject({ input: 31, output: 7, durationMs: expect.any(Number) });
});

test.skipIf(process.env.RUN_DELEGATION_GO !== '1')(
  'сравнение на синтетическом составном вопросе через Go',
  async () => {
    const apiKey = process.env.OPENCODE_API_KEY,
      mainModel = process.env.LLM_MODEL,
      output = process.env.DELEGATION_REPORT;
    if (!apiKey || !mainModel || !output)
      throw new Error('Нужны настройки Go и новый путь отчёта.');
    const remaining = Number(process.env.DELEGATION_REQUEST_LIMIT ?? requestLimit);
    if (!Number.isSafeInteger(remaining) || remaining < 1 || remaining > requestLimit)
      throw new Error('Некорректный лимит запросов Go.');
    const report = await compare({
      requestLimit: remaining,
      apiKey,
      mainModel,
      fetch,
      signal: AbortSignal.timeout(260_000),
    });
    await writeFile(output, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
    verify(report);
  },
  270_000,
);
