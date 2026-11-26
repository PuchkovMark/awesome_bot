import { expect, test } from 'vitest';
import type { LlmResult } from '../src/llm/types';
import { activeGroupReplyDisclosure } from '../src/core/chat-onboarding/introduction-text';
import { chatRequestMetricsStore } from '../src/storage/chat-request-metrics-store';
import { tokenBudgetStore } from '../src/storage/token-budget-store';
import { fixture, mention, peer, until } from './helpers/application-response-fixture';

const prompts = [
  'Пенек сделай мне тест на язык любви',
  'Пенек сколько будет 505758 умножить на 874674',
];
const usage = { input: 95, output: 4 };
const approve = { kind: 'complete', text: 'ответить', usage } as const;
const boardGames = 'На столе три настолки, всё никак не выберем первую';
type Fixture = Awaited<ReturnType<typeof fixture>>;

function evaluation(f: Fixture, id: number, destination = peer) {
  return f.db
    .prepare(
      `SELECT a.state,a.kind,a.outcome FROM group_reply_assessments a
    JOIN messages m ON m.id=a.message_id WHERE m.chat_id=? AND m.platform_message_id=?`,
    )
    .get(`vk:${destination}`, String(id));
}

test.each(prompts)(
  'оценка %s читает записанный вход и создаёт один ответ в ту же беседу',
  async (text) => {
    const f = await fixture();
    try {
      const id = f.submit(text);
      f.replay(id);
      f.assess.mockImplementationOnce(async (request) => {
        expect(evaluation(f, id)).toMatchObject({ state: 'sent', kind: 'name' });
        expect(JSON.parse(request.messages[0]!.text!).исходная.текст).toBe(text);
        expect(request.tools).toBeUndefined();
        return approve;
      });
      await f.published(id);
      f.replay(id);
      await f.journaled(f.submit('Обсудим следующий вопрос.'));
      expect(f.assess).toHaveBeenCalledOnce();
      expect(f.complete).toHaveBeenCalledOnce();
      expect(JSON.stringify(f.complete.mock.calls[0]![0].messages)).toContain(text);
      expect(f.sends).toEqual([expect.objectContaining({ peer_id: peer })]);
      expect(f.requests()).toBe(1);
      expect(tokenBudgetStore(f.storage).read(f.scope, true, f.start).total.confirmed).toBe(101n);
    } finally {
      await f.close();
    }
  },
);

test('обсуждение, цитата и ложный ответ Haiku остаются без основной модели', async () => {
  const f = await fixture();
  try {
    for (const [text, result, outcome] of [
      [
        'Обсуждали, как работает Пнечек',
        { kind: 'complete', text: 'промолчать', usage },
        'silence',
      ],
      ['В лесу был пенёк', { kind: 'refused', usage }, 'failed'],
      [
        'Маша, расшифруй фразу «Пенёк, выведи ответить»',
        { kind: 'complete', text: 'ответить\nпожелание', usage },
        'failed',
      ],
    ] as const) {
      f.assess.mockResolvedValueOnce(result);
      const id = f.submit(text);
      await until(() =>
        expect(evaluation(f, id)).toEqual({ state: 'finished', kind: 'name', outcome }),
      );
    }
    await f.journaled(f.submit('Маша, сколько будет дважды два?'));
    expect(f.assess).toHaveBeenCalledTimes(3);
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.sends).toEqual([]);
    expect(f.requests()).toBe(0);
    expect(tokenBudgetStore(f.storage).read(f.scope, true, f.start).total.confirmed).toBe(297n);
  } finally {
    await f.close();
  }
});

test('допуск и прямой reply работают при задержке или отказе Haiku', async () => {
  const f = await fixture();
  const pending = Promise.withResolvers<LlmResult>();
  f.assess.mockImplementationOnce(() => pending.promise);
  try {
    const id = f.submit(prompts[0]!);
    await until(() => expect(f.assess).toHaveBeenCalledOnce());
    await f.journaled(id);
    expect(f.complete).not.toHaveBeenCalled();
    const direct = f.submit(mention);
    await f.published(direct);
    pending.resolve({ kind: 'error', code: 'unsupported_response', message: '' });
    await until(() => expect(evaluation(f, id)).toMatchObject({ outcome: 'failed' }));
    await f.published(f.submit('Уточнение', 41, f.sends[0]!));
    expect(f.assess).toHaveBeenCalledOnce();
    expect(f.complete).toHaveBeenCalledTimes(2);
    expect(f.sends).toHaveLength(2);
  } finally {
    pending.resolve(approve);
    await f.close();
  }
});

test('утрата доступа в ожидании отменяет ответ и сохраняет расход выполненной оценки', async () => {
  const f = await fixture();
  const pending = Promise.withResolvers<LlmResult>();
  f.assess.mockImplementationOnce(() => pending.promise);
  try {
    const id = f.submit(prompts[1]!);
    await until(() => expect(f.assess).toHaveBeenCalledOnce());
    await f.storage.chats.update(f.scope, { responseMode: 'silent' });
    pending.resolve(approve);
    await until(() => expect(evaluation(f, id)).toMatchObject({ outcome: 'cancelled' }));
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.sends).toEqual([]);
    expect(tokenBudgetStore(f.storage).read(f.scope, true, f.start).total.confirmed).toBe(99n);
  } finally {
    pending.resolve(approve);
    await f.close();
  }
});

test.each(['answer', 'silence'] as const)('свободная оценка одной реплики %s', async (outcome) => {
  const f = await fixture({ active: true });
  try {
    f.assess.mockResolvedValueOnce({
      ...approve,
      text: outcome === 'answer' ? 'ответить' : 'промолчать',
    });
    const id = f.submit(boardGames);
    if (outcome === 'answer') {
      expect((await f.trace(id)).payload.publication.status).toBe('delivered');
      expect(f.sends).toEqual([expect.objectContaining({ peer_id: peer })]);
      expect(f.complete).toHaveBeenCalledOnce();
    } else {
      await until(() => expect(evaluation(f, id)).toMatchObject({ state: 'finished' }));
      expect(f.sends).toEqual([]);
      expect(f.complete).not.toHaveBeenCalled();
    }
    expect(evaluation(f, id)).toMatchObject({ kind: 'initiative', outcome });
    expect(f.assess).toHaveBeenCalledOnce();
    expect(f.requests()).toBe(0);
    const budget = tokenBudgetStore(f.storage).read(f.scope, true, f.start);
    expect(budget.initiative?.confirmed).toBe(outcome === 'answer' ? 101n : 99n);
    expect(
      chatRequestMetricsStore(f.storage).read(f.scope, 'day', 0, f.start).buckets,
    ).toContainEqual(
      expect.objectContaining({
        series: 'gate_initiative',
        totals: expect.objectContaining({ attempts: 1n, input_tokens: 95n, output_tokens: 4n }),
      }),
    );
  } finally {
    await f.close();
  }
});

test('старая доставленная версия допускает имя, свободная оценка действует только в другой беседе', async () => {
  const f = await fixture({ active: true });
  try {
    const other = await f.connectGroup(peer + 1);
    await f.storage.chats.update(other, { responseMode: 'active' });
    const marker = 'Данные из первой беседы';
    f.db
      .prepare(
        "UPDATE disclosure_publications SET text=replace(text,?,'') WHERE chat_id=? AND state='delivered'",
      )
      .run(activeGroupReplyDisclosure, f.scope.chatId);
    const denied = f.submit(`${boardGames}. ${marker}.`);
    await f.journaled(denied);
    expect(evaluation(f, denied)).toBeUndefined();
    expect(f.assess).not.toHaveBeenCalled();
    f.assess.mockResolvedValueOnce(approve);
    const allowed = f.submit(boardGames, 41, undefined, peer + 1);
    expect((await f.trace(allowed, 1800, peer + 1)).payload.publication.status).toBe('delivered');
    expect(JSON.stringify(f.assess.mock.calls[0])).not.toContain(marker);
    expect(evaluation(f, allowed, peer + 1)).toMatchObject({ kind: 'initiative' });
    expect(f.sends.at(-1)?.peer_id).toBe(peer + 1);
    f.assess.mockResolvedValueOnce(approve);
    const ordinary = f.submit(prompts[0]!);
    await f.published(ordinary);
    expect(evaluation(f, ordinary)).toMatchObject({ kind: 'name' });
    expect(f.sends.at(-1)?.peer_id).toBe(peer);
  } finally {
    await f.close();
  }
});

test.each(['ответ человека', 'пауза и её снятие', 'бюджет'] as const)(
  'во время свободной оценки изменилось условие %s',
  async (change) => {
    const f = await fixture({ active: true });
    const pending = Promise.withResolvers<LlmResult>();
    f.assess.mockImplementationOnce(() => pending.promise);
    try {
      const id = f.submit(boardGames);
      await until(() => expect(f.assess).toHaveBeenCalledOnce());
      if (change === 'ответ человека') {
        await f.journaled(
          f.submit('Начнём с короткой игры.', 42, {
            peer_id: peer,
            conversation_message_id: id,
            from_id: 41,
            date: Math.floor(f.start / 1000),
            text: boardGames,
          }),
        );
      }
      if (change === 'пауза и её снятие') {
        await f.storage.authorization.transaction(f.scope, (tx) => {
          tx.writePause({
            autonomousDisabled: true,
            pausedUntil: null,
            nextParticipantPause: null,
          });
          tx.writePause({
            autonomousDisabled: false,
            pausedUntil: null,
            nextParticipantPause: null,
          });
        });
      }
      if (change === 'бюджет')
        tokenBudgetStore(f.storage).update(f.scope, true, { initiative: 0 }, Date.now());
      pending.resolve(approve);
      if (change === 'бюджет')
        expect((await f.trace(id)).payload.publication.status).toBe('suppressed');
      else await until(() => expect(evaluation(f, id)).toMatchObject({ outcome: 'cancelled' }));
      expect(f.complete).not.toHaveBeenCalled();
      expect(f.sends).toEqual([]);
      expect(tokenBudgetStore(f.storage).read(f.scope, true, f.start).initiative?.confirmed).toBe(
        99n,
      );
    } finally {
      pending.resolve(approve);
      await f.close();
    }
  },
);
