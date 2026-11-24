import { expect, test, vi } from 'vitest';
import type { LlmRequest, LlmResult } from '../src/llm/types';
import type { SafeLogger } from '../src/logger/index';
import { lifecycleBackend } from '../src/storage/lifecycle-store';
import { noticeText } from '../src/storage/notice-types';
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

const rateLimit = { kind: 'error', code: 'rate_limit', message: 'Лимит' } as const;
const serverError = { kind: 'error', code: 'server', message: 'Ошибка' } as const;

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

function diagnosticLog() {
  const event = vi.fn<SafeLogger['event']>();
  return {
    logger: { event, componentError() {}, debugText() {}, debugError() {} },
    outcomes: () =>
      event.mock.calls.flatMap(([entry]) =>
        entry.event === 'llm_admission' ? [entry.outcome] : [],
      ),
  };
}

const destinations = [
  { mode: 'нормальная беседа', destination: peer, active: false, private: false },
  { mode: 'активная беседа', destination: peer, active: true, private: false },
  { mode: 'личка', destination: 41, active: false, private: true },
] as const;

async function readyPrivate(app: App) {
  app.submit('/персонаж', 41, undefined, 41);
  await until(() =>
    expect(
      app.sends.some(({ peer_id, text }) => peer_id === 41 && text.includes('Текущий персонаж')),
    ).toBe(true),
  );
}

function spending(app: App, destination: number) {
  const requests = app.db
    .prepare('SELECT count(*) FROM request_quota_admissions WHERE chat_id=?')
    .pluck()
    .get(`vk:${destination}`);
  const attempts = app.db
    .prepare(
      'SELECT input_tokens AS input,output_tokens AS output FROM token_budget_attempts WHERE chat_id=?',
    )
    .all(`vk:${destination}`);
  return { requests, attempts };
}

test.each(destinations)(
  '$mode — один 429, два локальных отказа и общий период уведомлений',
  async ({ destination, active, private: directMessage }) => {
    const diagnostics = diagnosticLog();
    const app = await fixture({ active, logger: diagnostics.logger });
    try {
      await app.connectGroup(other);
      if (directMessage) await readyPrivate(app);
      app.at(1_000);
      app.complete.mockResolvedValueOnce(rateLimit);
      const first = app.submit(dialog('Провайдер ограничил запросы'), 41, undefined, other);
      expect((await app.trace(first, 1_800, other)).payload).toMatchObject({
        resultKind: 'rate_limit',
        summary: { attempts: 1 },
      });
      for (let i = 0; i < 2; i++) {
        const text = `Обращение в паузе ${i + 1}`;
        const id = app.submit(directMessage ? text : dialog(text), 41, undefined, destination);
        const sent = !active && i === 0;
        expect((await app.trace(id, 1_800, destination)).payload).toMatchObject({
          resultKind: 'llm_provider_paused',
          summary: { attempts: 0 },
          model: { invoked: 'no' },
          publication: {
            rowId: 'llm_provider_paused',
            status: sent ? 'delivered' : 'suppressed',
            reason: active || sent ? 'none' : 'notice_period',
          },
        });
        expect(
          app.sends.find((item) => item.reply_message?.conversation_message_id === id)?.text,
        ).toBe(sent ? noticeText : undefined);
      }
      expect(app.complete).toHaveBeenCalledOnce();
      expect(diagnostics.outcomes()).toEqual([
        'rate_limit',
        'llm_provider_paused',
        'llm_provider_paused',
      ]);
      expect(spending(app, destination)).toEqual({ requests: 0, attempts: [] });
      expect(spending(app, other)).toEqual({
        requests: 1,
        attempts: [{ input: null, output: null }],
      });
    } finally {
      await app.close();
    }
  },
);

test.each(destinations)(
  '$mode — истечение ожидания без отправки и расхода',
  async ({ destination, active, private: directMessage }) => {
    const held = pending();
    const diagnostics = diagnosticLog();
    const app = await fixture({
      active,
      logger: diagnostics.logger,
      llmEnv: { LLM_CONCURRENT_CALLS: '1', LLM_SLOT_WAIT_MS: '80' },
    });
    try {
      await app.connectGroup(other);
      if (directMessage) await readyPrivate(app);
      app.complete.mockImplementationOnce(() => held.promise);
      const first = app.submit(dialog('Занятое место'), 41, undefined, other);
      await until(() => expect(app.complete).toHaveBeenCalledOnce());
      for (let i = 0; i < 2; i++) {
        const text = `Ожидающее обращение ${i + 1}`;
        const id = app.submit(directMessage ? text : dialog(text), 41, undefined, destination);
        const sent = !active && i === 0;
        expect((await app.trace(id, 1_800, destination)).payload).toMatchObject({
          resultKind: 'llm_wait_timeout',
          summary: { attempts: 0 },
          model: { invoked: 'no' },
          publication: {
            rowId: 'llm_wait_timeout',
            status: sent ? 'delivered' : 'suppressed',
            reason: active || sent ? 'none' : 'notice_period',
          },
        });
      }
      held.resolve(answer);
      await app.published(first);
      expect(app.complete).toHaveBeenCalledOnce();
      expect(diagnostics.outcomes()).toEqual(['llm_wait_timeout', 'llm_wait_timeout']);
      expect(spending(app, destination)).toEqual({ requests: 0, attempts: [] });
      expect(spending(app, other)).toEqual({ requests: 1, attempts: [{ input: 1, output: 1 }] });
    } finally {
      held.resolve(answer);
      await app.close();
    }
  },
);

test.each(['анкета', 'пересказ'] as const)(
  '429 в пути «%s» прекращает работу и ставит другой путь на паузу',
  async (firstPath) => {
    const diagnostics = diagnosticLog();
    const app = await fixture({
      profileNotice: 'В беседе разрешён профиль.',
      logger: diagnostics.logger,
    });
    try {
      await app.connectGroup(other);
      app.at(1_000);
      const questionnaire = firstPath === 'анкета' ? peer : other;
      const recap = firstPath === 'пересказ' ? peer : other;
      app.submit('/анкета', 41, undefined, questionnaire);
      await until(() =>
        expect(
          app.db
            .prepare('SELECT state FROM questionnaire_progress WHERE chat_id=?')
            .pluck()
            .get(`vk:${questionnaire}`),
        ).toBe('active'),
      );
      const scope = lifecycleBackend(app.storage).current(`vk:${recap}`);
      await app.storage.messages.append(scope, {
        chatId: scope.chatId,
        messageId: 'recap-source',
        userId: 'vk:41',
        authorName: 'Ира',
        role: 'user',
        text: 'Встречаемся завтра.',
        timestamp: app.start - 86_400_000,
      });
      const input = (destination: number) =>
        app.submit(
          destination === recap ? dialog('Что было вчера?') : dialog('Я Ира. Люблю походы.'),
          41,
          undefined,
          destination,
        );
      app.at(2_000);
      app.complete.mockResolvedValueOnce(rateLimit);
      const first = input(peer);
      expect((await app.trace(first)).payload).toMatchObject({
        resultKind: 'rate_limit',
        summary: { attempts: 1 },
        publication: { status: 'delivered' },
      });
      const second = input(other);
      expect((await app.trace(second, 1_800, other)).payload).toMatchObject({
        resultKind: 'llm_provider_paused',
        summary: { attempts: 0 },
        publication: { status: 'delivered' },
      });
      expect(
        app.sends.filter(({ text }) => text === 'собираю, минутку').map(({ peer_id }) => peer_id),
      ).toEqual(firstPath === 'пересказ' ? [peer] : []);
      expect(app.complete).toHaveBeenCalledOnce();
      expect(diagnostics.outcomes()).toEqual(['rate_limit', 'llm_provider_paused']);
      expect(spending(app, peer)).toEqual({
        requests: 1,
        attempts: [{ input: null, output: null }],
      });
      expect(spending(app, other)).toEqual({ requests: 0, attempts: [] });
    } finally {
      await app.close();
    }
  },
);

test('429 от помощника завершает родительское задание без продолжения', async () => {
  const diagnostics = diagnosticLog();
  const app = await fixture({ logger: diagnostics.logger });
  try {
    tokenBudgetStore(app.storage).update(app.scope, true, { total: 60_000 }, app.start);
    app.complete.mockResolvedValueOnce(toolCalls('ветвь')).mockResolvedValueOnce(rateLimit);
    const id = app.submit(dialog('Проверь это помощником'));
    expect((await app.trace(id)).payload).toMatchObject({
      resultKind: 'rate_limit',
      summary: { attempts: 2 },
    });
    expect(app.complete).toHaveBeenCalledTimes(2);
    expect(diagnostics.outcomes()).toEqual(['rate_limit']);
    expect(spending(app, peer)).toEqual({
      requests: 1,
      attempts: [
        { input: 10, output: 5 },
        { input: null, output: null },
      ],
    });
  } finally {
    await app.close();
  }
});

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

test.each(['Retry-After', 'без срока'] as const)(
  '429 %s переживает перезапуск, по выходе проходит один проверочный вызов',
  async (mode) => {
    const probe = pending();
    const app = await fixture({ active: true, threshold: 30 });
    try {
      const secondGroup = await app.connectGroup(other);
      for (const scope of [app.scope, secondGroup])
        tokenBudgetStore(app.storage).update(scope, true, { total: 100_000 }, app.start);
      const delay = mode === 'Retry-After' ? 5_000 : 30_000;
      app.at(1_000);
      app.complete.mockResolvedValueOnce(
        mode === 'Retry-After' ? { ...rateLimit, retryAt: app.start + 1_000 + delay } : rateLimit,
      );
      const failed = app.submit(dialog('Ответ с ограничением провайдера'));
      expect((await app.trace(failed)).payload).toMatchObject({
        resultKind: 'rate_limit',
        summary: { attempts: 1 },
      });
      await app.restart(true, [other]);
      app.at(1_000 + delay - 1);
      const paused = app.submit(dialog('Ответ во время паузы'));
      expect((await app.trace(paused)).payload).toMatchObject({
        resultKind: 'llm_provider_paused',
        summary: { attempts: 0 },
        model: { invoked: 'no' },
      });
      expect(app.complete).toHaveBeenCalledOnce();
      app.at(1_000 + delay);
      app.complete.mockImplementationOnce(() => probe.promise);
      const first = app.submit(dialog('Первый после паузы'));
      await until(() => expect(app.complete).toHaveBeenCalledTimes(2));
      const second = app.submit(dialog('Второй после паузы'), 41, undefined, other);
      await until(() => expect(running(app, other, second)).toBe('running'));
      expect(app.complete).toHaveBeenCalledTimes(2);
      probe.resolve(answer);
      await app.published(first);
      await app.published(second);
      expect(app.complete).toHaveBeenCalledTimes(3);
    } finally {
      probe.resolve(answer);
      await app.close();
    }
  },
);

test(
  'повтор 5xx проходит до порога, а три свежих сбоя переводят приложение в общую паузу',
  { timeout: 12_000 },
  async () => {
    const app = await fixture({ active: true, threshold: 30 });
    try {
      tokenBudgetStore(app.storage).update(app.scope, true, { total: 200_000 }, app.start);
      app.at(1_000);
      app.complete.mockResolvedValueOnce(serverError);
      const recovered = app.submit(dialog('Единичная ошибка'));
      expect((await app.trace(recovered, 3_000)).payload).toMatchObject({
        resultKind: 'complete',
        summary: { attempts: 2 },
      });
      app.complete.mockResolvedValue(serverError);
      app.at(2_000);
      const two = app.submit(dialog('Две ошибки подряд'));
      expect((await app.trace(two, 3_000)).payload.resultKind).toBe('attempt_limit');
      app.at(32_000);
      const outside = app.submit(dialog('Новая серия после окна'));
      expect((await app.trace(outside, 3_000)).payload.resultKind).toBe('attempt_limit');
      app.at(32_001);
      const threshold = app.submit(dialog('Третий ответ из серии'));
      expect((await app.trace(threshold, 3_000)).payload).toMatchObject({
        resultKind: 'llm_provider_paused',
        summary: { attempts: 1 },
      });
      expect(app.db.prepare('SELECT paused_until FROM llm_recovery').pluck().get()).toBe(
        app.start + 62_001,
      );
      expect(app.complete).toHaveBeenCalledTimes(7);
    } finally {
      await app.close();
    }
  },
);
