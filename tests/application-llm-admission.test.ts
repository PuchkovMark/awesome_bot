import { expect, test, vi } from 'vitest';
import type { LlmRequest, LlmResult } from '../src/llm/types';
import { lifecycleBackend } from '../src/storage/lifecycle-store';
import { tokenBudgetStore } from '../src/storage/token-budget-store';
import { answer, fixture, mention, peer, until } from './helpers/application-response-fixture';

type App = Awaited<ReturnType<typeof fixture>>;
const other = peer + 1;
const third = peer + 2;
const fourth = peer + 3;

function dialog(text: string) {
  return mention.replace('Вопрос', text);
}

function pending() {
  return Promise.withResolvers<LlmResult>();
}

function toolCalls(...ids: string[]): LlmResult {
  return {
    kind: 'tool_calls',
    calls: ids.map((id) => ({
      id,
      name: 'delegate',
      arguments: JSON.stringify({ goal: id, sources: ['current'], tools: [] }),
    })),
    text: null,
    usage: { input: 10, output: 5 },
  };
}

function helperAnswer(id: string): LlmResult {
  return { ...answer, text: JSON.stringify({ answer: id, citations: ['current'], gaps: [] }) };
}

function running(app: App, destination: number, event: number) {
  return app.db
    .prepare(
      `SELECT j.state FROM queue_jobs j JOIN messages m ON m.id=j.message_id
    WHERE j.chat_id=? AND m.platform_message_id=?`,
    )
    .pluck()
    .get(`vk:${destination}`, String(event));
}

test('две модели делят четыре места, пятый вызов ждёт освобождения помощника', async () => {
  const held = new Map(
    ['первый', 'второй', 'Группа Альфа', 'Группа Бета'].map((key) => [key, pending()]),
  );
  const sent: string[] = [];
  let active = 0;
  let peak = 0;
  async function record(label: string, result: LlmResult): Promise<LlmResult> {
    sent.push(label);
    peak = Math.max(++active, peak);
    try {
      return await (held.get(label)?.promise ?? result);
    } finally {
      active--;
    }
  }
  const main = vi.fn(async (request: LlmRequest) => {
    if (request.messages.some(({ role }) => role === 'tool')) return record('итог', answer);
    const input = request.messages.at(-1)?.text ?? '';
    if (input.includes('Две ветви')) return record('основная', toolCalls('первый', 'второй'));
    const group = ['Группа Альфа', 'Группа Бета', 'Группа Гамма'].find((name) =>
      input.includes(name),
    );
    return record(group ?? 'неизвестный запрос', answer);
  });
  const auxiliary = vi.fn(async (request: LlmRequest) => {
    const { goal } = JSON.parse(request.messages[0]!.text!) as { goal: string };
    return record(goal, helperAnswer(goal));
  });
  const app = await fixture({
    modelClients: { client: { complete: main }, auxiliaryClient: { complete: auxiliary } },
  });
  try {
    tokenBudgetStore(app.storage).update(app.scope, true, { total: 60_000 }, app.start);
    for (const destination of [other, third, fourth]) await app.connectGroup(destination);
    const parent = app.submit(dialog('Две ветви'));
    await until(() => expect(sent).toEqual(['основная', 'первый', 'второй']));
    app.submit(dialog('Группа Альфа'), 41, undefined, other);
    app.submit(dialog('Группа Бета'), 41, undefined, third);
    await until(() => expect(active).toBe(4));
    const waiting = app.submit(dialog('Группа Гамма'), 41, undefined, fourth);
    await until(() => expect(running(app, fourth, waiting)).toBe('running'));
    expect(sent).not.toContain('Группа Гамма');
    held.get('первый')!.resolve(helperAnswer('первый'));
    await until(() => expect(sent).toContain('Группа Гамма'));
    expect(sent).not.toContain('итог');
    for (const [label, call] of held)
      call.resolve(label === 'второй' ? helperAnswer(label) : answer);
    await app.published(parent);
    await app.published(waiting);
    expect(peak).toBe(4);
    expect(auxiliary).toHaveBeenCalledTimes(2);
    expect((await app.trace(parent)).payload.summary?.attempts).toBe(4);
  } finally {
    for (const call of held.values()) call.resolve(answer);
    await app.close();
  }
});

test('плановая сводка удерживает фоновое место, обновление профиля ждёт следующего прохода', async () => {
  const background = pending();
  const summarize = vi.fn(() => background.promise);
  const extract = vi.fn(async (request: LlmRequest) =>
    request.system.startsWith('Extract stable facts') ? { ...answer, text: '[]' } : answer,
  );
  const app = await fixture({
    profileNotice: 'В беседе разрешён профиль.',
    greetings: { members: [41, 73] },
    summaryIntervalMs: 15,
    summaryFragmentSize: 1,
    modelClients: { client: { complete: extract }, auxiliaryClient: { complete: summarize } },
  });
  try {
    const scope = await app.connectGroup(other);
    await app.storage.messages.append(scope, {
      chatId: scope.chatId,
      messageId: 'background-summary',
      role: 'user',
      userId: 'vk:41',
      authorName: 'Ира',
      text: 'Встречаемся завтра.',
      timestamp: app.start,
    });
    await until(() => expect(summarize).toHaveBeenCalledOnce());
    app.at(1_000);
    for (let i = 0; i < 10; i++) await app.journaled(app.submit(`Реплика участника ${i}`));
    await until(() =>
      expect(app.db.prepare('SELECT count(*) FROM profile_update_waiting').pluck().get()).toBe(10),
    );
    expect(extract).not.toHaveBeenCalled();
    const direct = app.submit(dialog('Прямой вопрос'));
    await app.published(direct);
    expect(summarize).toHaveBeenCalledOnce();
    expect(extract).toHaveBeenCalledOnce();
    background.resolve(answer);
    await vi.waitFor(
      () =>
        expect(
          extract.mock.calls.some(([request]) => request.system.startsWith('Extract stable facts')),
        ).toBe(true),
      { timeout: 2_500, interval: 5 },
    );
  } finally {
    background.resolve(answer);
    await app.close();
  }
});

test.each(['источник', 'поколение'] as const)(
  'в ожидании места проверяется %s',
  async (changed) => {
    const first = pending();
    const complete = vi.fn(async () => first.promise);
    const app = await fixture({
      llmEnv: { LLM_CONCURRENT_CALLS: '1' },
      modelClients: { client: { complete }, auxiliaryClient: { complete } },
    });
    try {
      const scope = await app.connectGroup(other);
      const primary = app.submit(dialog('Первое обращение'));
      await until(() => expect(complete).toHaveBeenCalledOnce());
      const waiting = app.submit(dialog('Устаревшее обращение'), 41, undefined, other);
      await until(() => expect(running(app, other, waiting)).toBe('running'));
      if (changed === 'источник') {
        app.db
          .prepare('DELETE FROM messages WHERE chat_id=? AND platform_message_id=?')
          .run(scope.chatId, String(waiting));
      } else {
        const lifecycle = lifecycleBackend(app.storage);
        lifecycle.ownerDelete(lifecycle.begin(scope.chatId), scope.generation);
      }
      first.resolve(answer);
      await app.published(primary);
      expect(complete).toHaveBeenCalledOnce();
      expect(
        app.db
          .prepare('SELECT count(*) FROM token_budget_attempts WHERE chat_id=?')
          .pluck()
          .get(scope.chatId),
      ).toBe(0);
    } finally {
      first.resolve(answer);
      await app.close();
    }
  },
);
