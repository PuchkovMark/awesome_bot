import { vi } from 'vitest';
import type { LlmRequest } from '../../src/llm/types';
import { chatSummaryStore } from '../../src/storage/chat-summary-store';
import { localDay } from '../../src/core/chat-summaries/calendar';
import { summaryEngine } from '../../src/core/chat-summaries/worker';
import { expect, test } from 'vitest';
import { fixture, until, chat, answer } from '../helpers/application-response-fixture';
import { estimateRequestInput } from '../../src/core/context/budget';
import { tokenBudgetStore } from '../../src/storage/token-budget-store';
test('пересказ 10 000 сообщений сохраняет факты из начала, середины и конца, затем использует кеш', async () => {
  const f = await fixture();
  try {
    tokenBudgetStore(f.storage).update(f.scope, true, { total: 5_000_000 }, f.start);
    const insert = f.db.prepare(
      "INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp) VALUES(?,?,'vk:41','Ира','user',?,?)",
    );
    const facts = ['Выбрали зал Б', 'Ира принесёт ключ', 'Перенос на 28 ноября'];
    f.db.transaction(() => {
      for (let i = 1; i <= 10000; i++)
        insert.run(
          chat,
          'load-' + i,
          i === 1
            ? facts[0]
            : i === 5010
              ? facts[1]
              : i === 10000
                ? facts[2]
                : i % 20 === 0
                  ? 'Подготовка продолжается'
                  : '👍',
          f.start - 86_400_000 + i,
        );
    })();
    const other = await f.connectGroup(2000000777);
    await f.storage.messages.append(other, {
      chatId: other.chatId,
      role: 'user',
      userId: 'vk:41',
      authorName: 'Ира',
      text: 'Чужая тайна',
      timestamp: f.start - 86_400_000,
      messageId: 'neighbor',
    });
    let maximum = 0;
    f.complete.mockImplementation(async (request) => {
      const data = request.messages[0]!.text!;
      expect(data).not.toMatch(/👍|Чужая тайна/u);
      maximum = Math.max(maximum, estimateRequestInput(request));
      const found = facts.filter((fact) => data.includes(fact));
      return { ...answer, text: found.length ? found.join('. ') : 'Подготовка продолжается' };
    });
    const ask = () => f.submit('[club314|Пенёк] Что было вчера?');
    ask();
    await expect
      .poll(() => f.sends.some((row) => facts.every((fact) => row.text.includes(fact))), {
        timeout: 15000,
        interval: 50,
      })
      .toBe(true);
    expect(maximum).toBeLessThanOrEqual(8000);
    const calls = f.complete.mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(41);
    const again = ask();
    await until(() =>
      expect(
        f.sends.some(
          (row) =>
            row.reply_message?.conversation_message_id === again &&
            facts.every((fact) => row.text.includes(fact)),
        ),
      ).toBe(true),
    );
    expect(f.complete.mock.calls.length).toBe(calls);
  } finally {
    await f.close();
  }
});

test('после закрытия 9999 сообщений позднее уточнение читает только одну новую реплику и обновляет неделю', async () => {
  const f = await fixture();
  try {
    const store = chatSummaryStore(f.storage);
    const read = vi.spyOn(store, 'messages');
    const engine = summaryEngine(store, 250);
    const day = localDay(f.start - 86400000, 'UTC');
    const add = f.db.prepare(
      "INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp) VALUES(?,?,'vk:41','Ира','user',?,?)",
    );
    f.db.transaction(() => {
      for (let i = 1; i < 10000; i++)
        add.run(
          chat,
          'late-' + i,
          i === 1 ? 'Зал Б' : i === 5000 ? 'Принесу ключ' : '👍',
          day.from + i,
        );
    })();
    const facts = ['Зал Б', 'Принесу ключ', 'Встреча 28 ноября'];
    let calls = 0;
    const run = () => ({
      scope: f.scope,
      cutoff: store.bounds(f.scope).cutoff!,
      current: () => true,
      compression: {
        signal: new AbortController().signal,
        sessionId: 'synthetic',
        inputLimit: 3500,
        outputLimit: 512,
        async invoke(request: LlmRequest) {
          calls++;
          const data = request.messages[0]!.text!;
          return { ...answer, text: facts.filter((fact) => data.includes(fact)).join('. ') };
        },
      },
    });
    await engine.maintain(run(), day.from, day.to, 'UTC');
    expect(read.mock.calls.map((call) => call[1].length)).toEqual([...Array(39).fill(250), 249]);
    const previous = run().cutoff;
    add.run(chat, 'late-10000', facts[2], day.from + 10000);
    read.mockClear();
    await engine.maintain(run(), day.from, day.to, 'UTC');
    expect(read.mock.calls.map((call) => call[1].length)).toEqual([1]);
    const latest = store.entries(f.scope, day, 'day', run().cutoff)[0]!;
    expect(latest.count).toBe(10000);
    expect(facts.every((fact) => latest.text.includes(fact))).toBe(true);
    expect(store.entries(f.scope, day, 'day', previous)[0]?.count).toBe(9999);
    const week = { from: localDay(day.to, 'UTC', -7).from, to: day.to, timezone: 'UTC' };
    expect(store.entries(f.scope, week, 'rolling', run().cutoff)[0]?.text).toContain('28 ноября');
    read.mockClear();
    const before = calls;
    await engine.maintain(run(), day.from, day.to, 'UTC');
    expect(read).not.toHaveBeenCalled();
    expect(calls).toBe(before);
  } finally {
    await f.close();
  }
});
