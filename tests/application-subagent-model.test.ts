import { afterEach, expect, test, vi } from 'vitest';
import { opencodeGoEndpoint } from '../src/llm/opencode';
import { tokenBudgetStore } from '../src/storage/token-budget-store';
import { answer, chat, fixture, mention } from './helpers/application-response-fixture';
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
  Response.json(completion(JSON.stringify({ answer: value, citations: [citation], gaps: [] })));
const toolResults = ({ messages }: WireRequest) =>
  messages.filter((message) => message.role === 'tool');

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
  const secondReady = Promise.withResolvers<void>();
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
    if (task.goal === 'second') secondReady.resolve();
    return branchAnswer(task.goal, 'read:' + readId);
  });
  const app = await fixture({ model: mainModel, modelClients: {} });
  try {
    tokenBudgetStore(app.storage).update(app.scope, true, { total: 100_000 }, app.start);
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
    const input = app.submit(mention);
    await secondReady.promise;
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
