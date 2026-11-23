import { personalDataStore } from '../src/storage/personal-data-store';
import { createAuthorizationService } from '../src/core/index';
import { participantRegistryStore } from '../src/storage/participant-registry';
import { authConfig } from './helpers/authorization-fixture';
import { tokenBudgetStore } from '../src/storage/token-budget-store';
import { expect, test } from 'vitest';
import { fixture, mention, answer, until, chat } from './helpers/application-response-fixture';
import type { LlmToolCall } from '../src/llm/types';

const calls = (...calls: LlmToolCall[]) => ({
  kind: 'tool_calls' as const,
  calls,
  usage: { input: 31, output: 7 },
  text: null,
});
const tool = (name: string, id: string, params: unknown) => ({
  name,
  id,
  arguments: JSON.stringify(params),
});
test('реестр в приложении: две параллельные ветви, четыре вызова, одна квота и один ответ VK', async () => {
  const app = await fixture();
  try {
    tokenBudgetStore(app.storage).update(app.scope, true, { total: 50000 }, app.start);
    app.complete.mockImplementation(async (request) => {
      if (request.system.includes('Выполни указанную подзадачу')) {
        expect(request.maxOutputTokens).toBe(640);
        expect(request.tools).toBeUndefined();
        return {
          kind: 'complete',
          text: JSON.stringify({ answer: 'вывод', citations: ['current'], gaps: [] }),
          usage: { input: 15, output: 4 },
        };
      }
      const results = request.messages.filter((m) => m.role === 'tool');
      if (!results.length) {
        expect(request.tools?.map((t) => t.name)).toContain('delegate');
        return calls(
          tool('delegate', 'first', { goal: 'Найди факт', sources: ['current'], tools: [] }),
          tool('delegate', 'second', { goal: 'Выбери вариант', sources: ['current'], tools: [] }),
        );
      }
      expect(results.map((m) => m.callId)).toEqual(['first', 'second']);
      expect(results.map((m) => JSON.parse(m.text).status)).toEqual(['complete', 'complete']);
      return answer;
    });
    const input = app.submit(mention);
    await app.published(input);
    expect(app.sends.filter((x) => x.text === answer.text)).toHaveLength(1);
    expect(app.complete).toHaveBeenCalledTimes(4);
    expect(app.requests()).toBe(1);
    expect(app.db.prepare('SELECT COUNT(*) FROM token_budget_attempts').pluck().get()).toBe(4);
    expect((await app.trace(input)).payload.summary).toMatchObject({ attempts: 4, steps: 4 });
  } finally {
    await app.close();
  }
});
test('карточка автора в обычном приложении, подмена чата отклонена до чтения', async () => {
  const app = await fixture();
  try {
    app.complete
      .mockResolvedValueOnce(
        calls(
          tool('participant_card', 'c', { ref: 'current' }),
          tool('participant_list', 'x', { chatId: 'vk:1' }),
        ),
      )
      .mockImplementation(async (request) => {
        const msgs = request.messages.filter((m) => m.role === 'tool');
        expect(msgs.map((m) => m.callId)).toEqual(['c', 'x']);
        const card = JSON.parse(msgs[0]!.text);
        expect(card.participants).toHaveLength(1);
        expect(card.participants[0].ref).toBe('participant1');
        expect(JSON.parse(msgs[1]!.text)).toEqual({ error: 'tool_denied' });
        return answer;
      });
    const input = app.submit(mention);
    await app.published(input);
    expect(app.sends.map((s) => s.text)).toContain(answer.text);
    expect((await app.trace(input)).payload.tools).toMatchObject([
      { name: 'participant_card', outcome: 'success' },
      { name: 'participant_list', outcome: 'denied' },
    ]);
  } finally {
    await app.close();
  }
});
test('удаление автора карточки во время финального ответа исключает публикацию', async () => {
  const app = await fixture();
  try {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    app.complete
      .mockResolvedValueOnce(calls(tool('participant_card', 'c', { ref: 'current' })))
      .mockImplementation(async () => {
        await wait;
        return answer;
      });
    const input = app.submit(mention);
    await until(() => expect(app.complete).toHaveBeenCalledTimes(2));
    app.db.prepare('DELETE FROM chat_participants WHERE chat_id=?').run(chat);
    release();
    await app.interrupted(input);
    expect(app.sends.some((s) => s.text === answer.text)).toBe(false);
  } finally {
    await app.close();
  }
});

test.each(['модель', 'лимитер'] as const)(
  'уход и быстрый возврат после чтения карточки блокируют прежнюю выдачу через %s',
  async (stage) => {
    const app = await fixture({ hold: stage === 'лимитер' });
    const gate = Promise.withResolvers<void>();
    const registry = participantRegistryStore(app.storage);
    const user = 'vk:41';
    try {
      app.at(1000);
      app.membership('chat_invite_user_by_link', 41);
      await until(() =>
        expect(registry.read(app.scope).participants).toContainEqual(
          expect.objectContaining({ userId: user, status: 'present' }),
        ),
      );
      app.complete
        .mockResolvedValueOnce(calls(tool('participant_card', 'c', { ref: 'current' })))
        .mockImplementationOnce(async (request) => {
          const found = request.messages.find((m) => m.role === 'tool');
          expect(JSON.parse(found!.text).participants).toHaveLength(1);
          if (stage === 'модель') await gate.promise;
          return answer;
        });
      const question = app.submit(mention);
      if (stage === 'модель') await until(() => expect(app.complete).toHaveBeenCalledTimes(2));
      else await until(() => expect(app.holds).toHaveLength(1));
      app.at(2000);
      app.membership('chat_kick_user', 41, 41);
      await until(() =>
        expect(registry.departure(app.scope, user)).toMatchObject({
          departedAt: app.start + 2000,
          returnedAt: null,
        }),
      );
      app.at(3000);
      app.membership('chat_invite_user_by_link', 41);
      await until(() =>
        expect(registry.departure(app.scope, user)?.returnedAt).toBe(app.start + 3000),
      );
      gate.resolve();
      if (stage === 'модель') {
        await app.interrupted(question);
      } else {
        app.holds[0]!.release();
        await app.holds[0]!.finished;
      }
      expect(app.sends.filter((row) => row.text === answer.text)).toHaveLength(0);
    } finally {
      gate.resolve();
      await app.close();
    }
  },
);

test('публичный интерес из профиля исчезает во время продолжения, ответ остаётся локальным', async () => {
  const app = await fixture({ profileNotice: 'Профиль используется в беседе.' });
  const auth = await createAuthorizationService({
    config: authConfig,
    store: app.storage.authorization,
  });
  const user = 'vk:73';
  try {
    app.at(1000);
    participantRegistryStore(app.storage).observe(app.scope, {
      kind: 'membership',
      chatId: chat,
      change: 'joined',
      timestamp: app.start + 1000,
      subjectId: user,
      actorId: user,
      eventId: 'join-test',
    });
    const record = async (text: string) => {
      const platformId = app.submit(text, 73);
      await app.journaled(platformId);
      return app.db
        .prepare('SELECT id FROM messages WHERE chat_id=? AND platform_message_id=?')
        .pluck()
        .get(chat, String(platformId)) as number;
    };
    const context = auth.context({ scope: app.scope, userId: user });
    const messageId = await record('Мой интерес — гончарное дело.');
    await auth.changeProfileFact(context, {
      subjectId: user,
      messageId,
      change: {
        kind: 'set',
        fieldKey: 'interest',
        value: 'Гончарное дело',
        reliability: 'unverified',
      },
    });
    expect(
      app.storage.profileFacts.searchInterests(app.scope, 'гончарное дело').matches,
    ).toHaveLength(1);
    const hideId = await record('Скрой мой интерес.');
    const wait = Promise.withResolvers<void>();
    app.complete
      .mockResolvedValueOnce(calls(tool('participant_search', 'find', { query: 'гончарное дело' })))
      .mockImplementation(async (request) => {
        const result = request.messages.find((m) => m.role === 'tool');
        expect(JSON.parse(result!.text).participants).toHaveLength(1);
        await wait.promise;
        return answer;
      });
    const input = app.submit(mention + ' Кто увлекается гончарным делом?');
    await until(() => expect(app.complete).toHaveBeenCalledTimes(2));
    await auth.changeProfileFact(context, {
      subjectId: user,
      messageId: hideId,
      change: {
        kind: 'visibility',
        fieldKey: 'interest',
        interest: 'Гончарное дело',
        visibility: 'bot',
      },
    });
    wait.resolve();
    await app.interrupted(input);
    expect(app.sends).toHaveLength(0);
  } finally {
    auth.dispose();
    await app.close();
  }
});

test('повтор продолжения после ошибки сервера сохраняет ответ инструмента и одну ссылку на участника', async () => {
  const app = await fixture();
  try {
    app.complete
      .mockResolvedValueOnce(calls(tool('participant_card', 'card', { ref: 'current' })))
      .mockResolvedValueOnce({ kind: 'error', code: 'server', message: 'synthetic' })
      .mockResolvedValueOnce(answer);
    const id = app.submit(mention);
    await app.published(id);
    expect(app.complete).toHaveBeenCalledTimes(3);
    expect(app.complete.mock.calls[1]![0].messages).toEqual(
      app.complete.mock.calls[2]![0].messages,
    );
    const trace = await app.trace(id);
    expect(trace.payload.tools).toHaveLength(1);
    expect(app.requests()).toBe(1);
    const dependent = app.db
      .prepare('SELECT answer_id AS id FROM tool_answer_subjects WHERE user_id=?')
      .get('vk:41') as { id: number };
    expect(dependent).toBeTruthy();
    const privacy = personalDataStore(app.storage);
    const deletion = privacy.requestDeletion(app.scope, 'vk:41', 'delete', app.start + 2000);
    expect(privacy.confirmDeletion(app.scope, 'vk:41', deletion.code, app.start + 3000)).toBe(true);
    expect(
      app.db.prepare('SELECT 1 FROM personal_visible_messages WHERE id=?').get(dependent.id),
    ).toBeUndefined();
  } finally {
    await app.close();
  }
});
