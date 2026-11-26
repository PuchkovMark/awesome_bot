import { expect, test } from 'vitest';
import type { LlmResult } from '../src/llm/types';
import { tokenBudgetStore } from '../src/storage/token-budget-store';
import { fixture, mention, peer, until } from './helpers/application-response-fixture';

const prompts = [
  'Пенек сделай мне тест на язык любви',
  'Пенек сколько будет 505758 умножить на 874674',
];
const usage = { input: 95, output: 4 };
const approve = { kind: 'complete', text: 'ответить', usage } as const;
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
