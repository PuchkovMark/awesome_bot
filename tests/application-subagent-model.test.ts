import { afterEach, expect, test, vi } from 'vitest';
import { opencodeGoEndpoint } from '../src/llm/opencode';
import { tokenBudgetStore } from '../src/storage/token-budget-store';
import { answer, chat, fixture, mention, until } from './helpers/application-response-fixture';
import { completion, toolCall } from './helpers/llm-http';

const mainModel = 'synthetic-other-main';
const haiku = 'claude-haiku-5-5';
type WireRequest = {
  model: string;
  max_tokens: number;
  messages: { role: string; content: string; tool_call_id?: string }[];
};

function transport(respond: (request: WireRequest, index: number) => Response | Promise<Response>) {
  const requests: WireRequest[] = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    expect(url).toBe(opencodeGoEndpoint);
    const request = JSON.parse(String(init.body)) as WireRequest;
    return respond(request, requests.push(request) - 1);
  });
  return requests;
}

const calls = (...parts: ReturnType<typeof toolCall>[]) =>
  Response.json(completion(null, 'tool_calls', { tool_calls: parts }));
const delegate = (id: string, sources: string[], tools: string[] = []) =>
  toolCall(id, 'delegate', JSON.stringify({ goal: id, sources, tools }));
const branchAnswer = (value: string, citation: string) =>
  Response.json({
    ...completion(JSON.stringify({ answer: value, citations: [citation], gaps: [] })),
    usage: { prompt_tokens: 22, completion_tokens: 5 },
  });
const toolResults = ({ messages }: WireRequest) =>
  messages.filter((message) => message.role === 'tool');

async function seedSchedule(app: Awaited<ReturnType<typeof fixture>>) {
  const budget = tokenBudgetStore(app.storage);
  budget.update(app.scope, true, { total: 100_000 }, app.start);
  await app.storage.messages.append(app.scope, {
    chatId: chat,
    userId: 'vk:73',
    role: 'user',
    authorName: 'Саша',
    isGroupChat: true,
    messageId: 'schedule',
    timestamp: app.start - 1000,
    text: 'Зал Б в 18:00.',
  });
  return budget;
}

afterEach(() => vi.unstubAllGlobals());

test('прямой ответ использует только настроенную основную модель', async () => {
  const requests = transport(() => Response.json(completion(answer.text)));
  const app = await fixture({ model: mainModel, modelClients: {} });
  try {
    await app.published(app.submit(mention));
    expect(requests.map(({ model }) => model)).toEqual([mainModel]);
    expect(app.sends.map(({ text }) => text)).toEqual([answer.text]);
  } finally {
    await app.close();
  }
});

test('обе ветви продолжают на Haiku после чтения и возвращаются основной модели в порядке поручений', async () => {
  const releaseFirst = Promise.withResolvers<void>();
  const finished: string[] = [];
  const requests = transport(async (request, index) => {
    if (index === 0)
      return calls(
        delegate('first', [], ['history_search']),
        delegate('second', [], ['history_search']),
      );
    if (request.model === mainModel) return Response.json(completion(answer.text));
    expect(request.max_tokens).toBe(640);
    const task = JSON.parse(request.messages[1]!.content);
    const readId = 'read-' + task.goal;
    const [result] = toolResults(request);
    if (!result) return calls(toolCall(readId, 'history_search', '{"query":"Зал","limit":1}'));
    expect(result.tool_call_id).toBe(readId);
    expect(JSON.parse(JSON.parse(result.content).text).messages).toMatchObject([
      { text: 'Зал Б в 18:00.' },
    ]);
    if (task.goal === 'first') await releaseFirst.promise;
    finished.push(task.goal);
    return branchAnswer(task.goal, 'read:' + readId);
  });
  const app = await fixture({ model: mainModel, modelClients: {} });
  try {
    await seedSchedule(app);
    const input = app.submit(mention);
    await until(() => expect(finished).toEqual(['second']));
    releaseFirst.resolve();
    await app.published(input);
    expect(finished).toEqual(['second', 'first']);
    expect(requests.map(({ model }) => model)).toEqual([
      mainModel,
      haiku,
      haiku,
      haiku,
      haiku,
      mainModel,
    ]);
    expect(
      toolResults(requests.at(-1)!).map(({ content, tool_call_id }) => [
        tool_call_id,
        JSON.parse(content).answer,
      ]),
    ).toEqual([
      ['first', 'first'],
      ['second', 'second'],
    ]);
    expect(app.sends.map(({ text }) => text)).toEqual([answer.text]);
    expect(app.requests()).toBe(1);
  } finally {
    releaseFirst.resolve();
    await app.close();
  }
});

test('следующая ветвь получает результат первой и использует общую настройку вспомогательной модели', async () => {
  const auxiliaryModel = 'synthetic-auxiliary';
  const requests = transport((request, index) => {
    if (index === 0) return calls(delegate('first', ['current']));
    if (index === 1) return branchAnswer('Зал Б', 'current');
    if (index === 2) return calls(delegate('second', ['delegate:first']));
    if (index === 3) {
      expect(JSON.parse(request.messages[1]!.content).materials).toMatchObject([
        { ref: 'delegate:first', text: expect.stringContaining('Зал Б') },
      ]);
      return branchAnswer('Подходит зал Б', 'delegate:first');
    }
    return Response.json(completion(answer.text));
  });
  const app = await fixture({ model: mainModel, auxiliaryModel, modelClients: {} });
  try {
    tokenBudgetStore(app.storage).update(app.scope, true, { total: 100_000 }, app.start);
    await app.published(app.submit(mention));
    expect(requests.map(({ model }) => model)).toEqual([
      mainModel,
      auxiliaryModel,
      mainModel,
      auxiliaryModel,
      mainModel,
    ]);
    expect(toolResults(requests.at(-1)!).map(({ content }) => JSON.parse(content).answer)).toEqual([
      'Зал Б',
      'Подходит зал Б',
    ]);
    expect(app.sends.map(({ text }) => text)).toEqual([answer.text]);
  } finally {
    await app.close();
  }
});

test.each([
  { mode: 'retry', status: 'complete', count: 5 },
  { mode: 'quota', status: 'limit', count: 4 },
  { mode: 'unavailable', status: 'unavailable', count: 4 },
])('сбой Haiku при продолжении: $mode, результат $status', async ({ mode, status, count }) => {
  let restrictBudget: () => void;
  const requests = transport((_request, index) => {
    if (index === 0) return calls(delegate('schedule', [], ['history_search']));
    if (index === 1) return calls(toolCall('read', 'history_search', '{"query":"Зал","limit":1}'));
    if (index === 2) {
      if (mode === 'quota') restrictBudget();
      return new Response(null, { status: mode === 'unavailable' ? 403 : 503 });
    }
    if (mode === 'retry' && index === 3) return branchAnswer('Зал Б в 18:00.', 'read:read');
    return Response.json(completion(answer.text));
  });
  const app = await fixture({ model: mainModel, modelClients: {} });
  try {
    const budget = await seedSchedule(app);
    restrictBudget = () => {
      const { reserved } = budget.read(app.scope, true, app.start).total;
      budget.update(app.scope, true, { total: Number(reserved) }, app.start);
    };
    const input = app.submit(mention);
    await app.published(input);
    expect(requests.map(({ model }) => model)).toEqual([
      mainModel,
      ...Array<string>(count - 2).fill(haiku),
      mainModel,
    ]);
    expect(JSON.parse(toolResults(requests.at(-1)!)[0]!.content).status).toBe(status);
    expect(toolResults(requests[2]!)[0]?.content).toContain('Зал Б в 18:00.');
    const trace = (await app.trace(input)).payload;
    expect(trace.tools.filter(({ name }) => name === 'history_search')).toHaveLength(1);
    expect(trace.summary).toMatchObject({
      attempts: count,
      steps: 4,
      attemptsPerStep: [1, 1, 1, mode === 'retry' ? 2 : 1],
    });
    const ledger = app.db
      .prepare(
        'SELECT attempt_key, input_tokens, output_tokens FROM token_budget_attempts ORDER BY rowid',
      )
      .all() as {
      attempt_key: string;
      input_tokens: number | null;
      output_tokens: number | null;
    }[];
    expect(ledger).toHaveLength(count);
    expect(new Set(ledger.map(({ attempt_key }) => attempt_key)).size).toBe(count);
    expect(ledger[2]).toMatchObject({ input_tokens: null, output_tokens: null });
    if (mode === 'retry') {
      expect(requests[3]).toEqual(requests[2]);
      expect(ledger[3]).toMatchObject({ input_tokens: 22, output_tokens: 5 });
    }
    expect(app.requests()).toBe(1);
    expect(app.sends.map(({ text }) => text)).toEqual([answer.text]);
  } finally {
    await app.close();
  }
});
