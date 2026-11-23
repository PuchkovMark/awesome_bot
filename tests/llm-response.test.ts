import { expect, test } from 'vitest';
import { completion, fakeClient, llmRequest } from './helpers/llm-http';

test.each([
  [completion('  Буквально\n'), 'complete'],
  [completion('часть', 'length'), 'incomplete'],
  [completion('', 'content_filter'), 'refused'],
  [completion(null, 'stop', { refusal: 'private refusal' }), 'refused'],
  [completion(''), 'empty'],
  [completion(' \n'), 'empty'],
  [completion(null), 'empty'],
])('нормализация текста и отдельных исходов', async (value, kind) => {
  const { client } = fakeClient(value);
  const result = await client.complete(llmRequest());
  expect(result.kind).toBe(kind);
  expect(JSON.stringify(result)).not.toContain('private refusal');
  if (result.kind === 'complete') expect(result.text).toBe('  Буквально\n');
});
test.each([
  null,
  {},
  { choices: [] },
  { choices: [completion().choices[0], completion().choices[0]] },
  completion(42),
  completion('x', 'stop', { role: 'user' }),
  completion('x', 'stop', { refusal: {} }),
])('повреждённая структура отклоняется', async (value) => {
  expect(await fakeClient(value).client.complete(llmRequest())).toMatchObject({
    code: 'invalid_response',
  });
});
test('неизвестное завершение — отдельная ошибка', async () => {
  expect(
    await fakeClient(completion('text', 'unknown')).client.complete(llmRequest()),
  ).toMatchObject({ code: 'unsupported_response' });
});
test.each([
  [undefined, null, null],
  [{ prompt_tokens: 0, completion_tokens: 5 }, 0, 5],
  [{ prompt_tokens: -1, completion_tokens: 2 }, null, 2],
  [{ prompt_tokens: 5, completion_tokens: '9' }, 5, null],
  [{ prompt_tokens: 1.5, completion_tokens: Number.MAX_SAFE_INTEGER + 1 }, null, null],
])('usage не выдумывается и не суммируется', async (usage, input, output) => {
  const result = await fakeClient({ ...completion(), usage }).client.complete(llmRequest());
  expect(result).toMatchObject({ usage: { input, output } });
});
test('рассуждения и лишние поля не выдаются наружу', async () => {
  const result = await fakeClient(
    completion('Ответ', 'stop', { reasoning_content: 'PRIVATE' }),
  ).client.complete(llmRequest());
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
});
