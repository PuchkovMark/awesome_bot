import { expect, test, vi } from 'vitest';
import { createDelegation, type DelegationHost } from '../src/core/agent-loop/delegation';
import { delegateFeedback, finalRequestReserve } from '../src/core/chat-queue/delegated-attempts';
import { estimateRequestInput } from '../src/core/context/budget';
import type { LlmRequest, LlmResult } from '../src/llm/types';

const prompt = (goal: string, sources: string[] = [], tools: string[] = [], id = goal) => ({
  name: 'delegate',
  id,
  arguments: JSON.stringify({ goal, sources, tools }),
});
const done = (answer: string, citations: string[] = []): LlmResult => ({
  kind: 'complete',
  text: JSON.stringify({ answer, citations, gaps: [] }),
  usage: { input: 1, output: 1 },
});
const tool = (name: string, access: 'read' | 'write') => ({
  name,
  access,
  description: name,
  parameters: { type: 'object' as const },
});
function fixture(changes: Partial<DelegationHost> = {}) {
  const controller = new AbortController();
  const attempt = vi.fn<DelegationHost['attempt']>(async () => done('готово'));
  const read = vi.fn<DelegationHost['read']>(async () => undefined);
  const host: DelegationHost = {
    sessionId: 'opaque',
    maxOutputTokens: 1024,
    signal: controller.signal,
    resolve: (ref) => (ref === 'a' ? { ref, text: 'факт А', messageIds: [17] } : undefined),
    visible: () => true,
    allowedTools: () => [tool('lookup', 'read'), tool('mutate', 'write'), tool('delegate', 'read')],
    takeHelperStep: () => true,
    attempt,
    read,
    ...changes,
  };
  return { execute: createDelegation(host), attempt, read, controller };
}
test('независимые вызовы сохраняют свои результаты, повтор не создаёт попытку', async () => {
  for (const first of [0, 1]) {
    const resolvers: ((result: LlmResult) => void)[] = [];
    const f = fixture();
    f.attempt.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
    const calls = [prompt('первый', ['a']), prompt('второй')];
    const promises = calls.map((c) => f.execute(c));
    const duplicate = f.execute(calls[0]!);
    await Promise.resolve();
    expect(f.attempt).toHaveBeenCalledTimes(2);
    resolvers[first]!(done(String(first)));
    resolvers[1 - first]!(done(String(1 - first)));
    expect(await Promise.all(promises)).toMatchObject([
      { answer: '0', messageIds: [17] },
      { answer: '1', messageIds: [] },
    ]);
    expect(await duplicate).toMatchObject({ answer: '0' });
    expect(await f.execute(prompt('третий'))).toMatchObject({ status: 'limit' });
    expect(f.attempt.mock.calls[1]![0].messages[0]!.text).not.toContain('факт А');
  }
});
test('последовательная подзадача наследует зависимости первого вывода', async () => {
  const f = fixture();
  f.attempt
    .mockResolvedValueOnce(done('извлечённый факт', ['a']))
    .mockResolvedValueOnce(done('сравнение', ['delegate:one']));
  await f.execute(prompt('выбери', ['a'], [], 'one'));
  const result = await f.execute(prompt('сравни', ['delegate:one']));
  expect(result).toMatchObject({ status: 'complete', messageIds: [17] });
  expect(f.attempt.mock.calls[1]![0].messages[0]!.text).toContain('извлечённый факт');
});
test('границы 2560/640 включают весь запрос, недоступное основание не запускает модель', async () => {
  const probe = fixture();
  await probe.execute(prompt('a'));
  const base = probe.attempt.mock.calls[0]![0];
  const n = 2560 - estimateRequestInput(base) + 1;
  const f = fixture();
  await f.execute(prompt('a'.repeat(n), [], [], 'a'));
  expect(estimateRequestInput(f.attempt.mock.calls[0]![0])).toBe(2560);
  expect(f.attempt.mock.calls[0]![0].maxOutputTokens).toBe(640);
  expect(await f.execute(prompt('a'.repeat(n + 1), [], [], 'b'))).toMatchObject({
    status: 'limit',
  });
  expect(f.attempt).toHaveBeenCalledTimes(1);
  for (const call of [
    prompt('a', ['другой чат']),
    prompt('a', [], ['delegate']),
    prompt('a', [], ['mutate']),
    { ...prompt('a'), arguments: '{"goal":"а","sources":[],"tools":[],"role":"owner"}' },
  ]) {
    const denied = fixture();
    expect(await denied.execute(call)).toMatchObject({ status: 'unavailable' });
    expect(denied.attempt).not.toHaveBeenCalled();
  }
});
test('чтение повторно проверяет права, источники и размер результата', async () => {
  const f = fixture();
  f.attempt
    .mockResolvedValueOnce({
      kind: 'tool_calls',
      calls: [{ name: 'lookup', id: 'r', arguments: '{}' }],
      text: null,
      usage: { input: 0, output: 1 },
    })
    .mockResolvedValueOnce(done('ответ', ['b']));
  f.read.mockResolvedValue({ ref: 'b', text: 'данные', messageIds: [21] });
  const result = await f.execute(prompt('читай', [], ['lookup']));
  expect(result).toMatchObject({ messageIds: [21], citations: ['b'] });
  expect(f.attempt.mock.calls[1]![0].messages.at(-1)).toMatchObject({ role: 'tool', callId: 'r' });
  const denied = fixture();
  denied.attempt.mockResolvedValueOnce({
    kind: 'tool_calls',
    calls: [{ name: 'mutate', id: 'x', arguments: '{}' }],
    text: null,
    usage: { input: 1, output: 1 },
  });
  expect(await denied.execute(prompt('читай', [], ['lookup']))).toMatchObject({
    status: 'unavailable',
  });
  expect(denied.read).not.toHaveBeenCalled();
  const forged = fixture();
  forged.attempt.mockResolvedValueOnce(done('якобы', ['unknown']));
  expect(await forged.execute(prompt('проверь'))).toMatchObject({
    status: 'incomplete',
    answer: '',
  });
});
test('отмена завершает ветвь даже при зависшем клиенте, исчезновение источника скрывает поздний ответ', async () => {
  const f = fixture();
  f.attempt.mockImplementation(() => new Promise(() => {}));
  const result = f.execute(prompt('долго'));
  await Promise.resolve();
  f.controller.abort();
  expect(await result).toMatchObject({ status: 'cancelled' });
  let visible = true;
  const stale = fixture({ visible: () => visible });
  stale.attempt.mockImplementation(async () => {
    visible = false;
    return done('секрет', ['a']);
  });
  expect(await stale.execute(prompt('факт', ['a']))).toMatchObject({
    status: 'cancelled',
    answer: '',
  });
});
test('резерв покрывает сериализованный ответ ветви и не раскрывает технические ID', () => {
  const base: LlmRequest = {
    system: 'test',
    messages: [{ role: 'user', text: 'вопрос' }],
    sessionId: 'opaque',
    maxOutputTokens: 1024,
  };
  for (const answer of ['факт', '\\'.repeat(8000)]) {
    const msg = delegateFeedback('a', {
      status: 'complete',
      answer,
      citations: [],
      gaps: [],
      messageIds: [17],
    });
    expect(msg.text).not.toContain('messageIds');
    expect(finalRequestReserve(base, ['a'])).toBeGreaterThanOrEqual(
      estimateRequestInput({ ...base, messages: [...base.messages, msg] }) + 1024,
    );
  }
});

test('продолжение получает те же схемы и исходные сообщения, когда карточка перестала помещаться', async () => {
  const { createAgentLoop } = await import('../src/core/agent-loop/service');
  const { createParticipantCardComposer } = await import('../src/core/context/participant-cards');
  const text =
    '{"kind":"untrusted_chat_data","history":[{"text":"История"}],"reply":null,"current":{"text":"Запрос"}}';
  const base = {
    system: 'Главные правила.',
    messages: [{ role: 'user' as const, text }],
    sessionId: 'opaque',
    maxOutputTokens: 640,
  };
  const issued = [tool('lookup', 'read')];
  const complete = vi
    .fn<(request: LlmRequest) => Promise<LlmResult>>()
    .mockResolvedValueOnce({
      kind: 'tool_calls',
      calls: [{ name: 'lookup', id: 'lookup-1', arguments: '{}' }],
      text: null,
      usage: { input: 1, output: 1 },
    })
    .mockResolvedValueOnce({ kind: 'complete', text: 'Готово.', usage: { input: 1, output: 1 } });
  const schemas = vi.fn<(request: LlmRequest) => Promise<typeof issued>>(async () => issued);
  const beginBatch = vi.fn();
  const composer = createParticipantCardComposer({
    candidates: [{ id: 1, timestamp: 1, userId: 'vk:41', author: 'Саша', authorLabel: 'u1' }],
    messageIndex: 0,
    modelContextTokens: 2350,
    read: () => ({
      facts: [
        {
          value: {
            fieldKey: 'заметка',
            value: 'с'.repeat(530),
            sourceKind: 'self',
            reliability: 'confirmed',
          },
          reference: {} as import('../src/contracts/profile-facts').ContextCardFactReference,
          sourceIds: [17],
        },
      ],
    }),
    current: () => true,
  });
  const run = createAgentLoop(
    { complete },
    {},
    undefined,
    undefined,
    {
      schemas,
      beginBatch,
      execute: async () => 'Аргументы.'.repeat(50),
      helperSteps: () => 0,
      trace: () => [],
      current: () => true,
      sourceIds: () => [],
      labels: () => [],
    },
    (request) => composer(request).request,
  );
  expect(await run.run(base)).toMatchObject({ kind: 'complete' });
  expect(complete).toHaveBeenCalledTimes(2);
  const [first, next] = complete.mock.calls.map(([request]) => request);
  expect(first?.messages[0]?.text).toContain('participantCards');
  expect(next?.messages[0]?.text).toBe(text);
  expect(next?.tools).toEqual(first?.tools);
  expect(next?.messages.map(({ role }) => role)).toEqual(['user', 'assistant', 'tool']);
  expect(schemas.mock.calls.map(([request]) => request?.messages[0]?.text)).toEqual([text, text]);
  expect(beginBatch.mock.calls[0]?.[0].messages[0].text).toContain('participantCards');
});
