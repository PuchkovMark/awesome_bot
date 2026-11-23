import { recordQueueLoad } from '../helpers/queue-load-fixture';
import { tokenBudgetStore } from '../../src/storage/token-budget-store';
import { expect, test } from 'vitest';
import { estimateRequestInput, messageInputCost } from '../../src/core/context/budget';
import { answer, chat, fixture, mention } from '../helpers/application-response-fixture';

test('обе выдачи при 10 000 сообщениях в сутках остаются в пределах полного запроса', async () => {
  const app = await fixture();
  try {
    tokenBudgetStore(app.storage).update(app.scope, true, { total: 250000 }, app.start);
    const from = app.start - 86400000,
      to = app.start;
    app.db
      .prepare(
        `WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<10000)
      INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp)
      SELECT ?, 'load-'||i,'vk:73','Саша','user','Маяк '||i,?+i FROM n`,
      )
      .run(chat, from);
    const other = await app.connectGroup(2000000777);
    await app.storage.messages.append(other, {
      chatId: other.chatId,
      userId: 'vk:73',
      authorName: 'Саша',
      role: 'user',
      text: 'Маяк чужой',
      timestamp: from + 1,
      messageId: 'other',
    });
    const stored = app.storage.contextMessages.history(app.scope, {
      kind: 'period',
      from,
      to,
      cutoffId: Number.MAX_SAFE_INTEGER,
      limit: 40,
    });
    expect(stored.found).toBe(10000);
    expect(stored.rows).toHaveLength(40);
    const dates = {
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      limit: 10000,
    };
    app.complete
      .mockResolvedValueOnce({
        kind: 'tool_calls',
        text: null,
        usage: { input: 1, output: 1 },
        calls: [
          {
            name: 'history_search',
            id: 's',
            arguments: JSON.stringify({ ...dates, query: 'Маяк' }),
          },
          { name: 'history_period', id: 'p', arguments: JSON.stringify(dates) },
        ],
      })
      .mockResolvedValueOnce(answer);
    const id = app.submit(mention);
    await app.published(id);
    const trace = await app.trace(id);
    expect(trace.payload.resultKind, JSON.stringify(trace.payload.tools)).toBe('complete');
    const request = app.complete.mock.calls[1]![0];
    const results = request.messages.filter((m) => m.role === 'tool');
    expect(results).toHaveLength(2);
    const measured = [];
    for (const message of results) {
      const { found, shown, messages, first, last, hint } = JSON.parse(message.text);
      expect(found).toBe(10000);
      expect(shown).toBe(messages.length);
      expect(shown).toBeGreaterThan(0);
      expect(shown).toBeLessThanOrEqual(40);
      expect(last).toBe(new Date(from + 10000).toISOString());
      expect(first).toBe(new Date(from + 10001 - shown).toISOString());
      expect(messageInputCost(Buffer.byteLength(JSON.stringify(message)))).toBeLessThanOrEqual(
        2048,
      );
      expect(message.text).not.toContain('чужой');
      expect(hint).toBeTruthy();
      measured.push({
        tool: message.callId === 's' ? 'history_search' : 'history_period',
        found,
        shown,
        cost: messageInputCost(Buffer.byteLength(JSON.stringify(message))),
      });
    }
    await recordQueueLoad({
      scenario: 'history-tools-055',
      databaseRows: stored.rows.length,
      results: measured,
      input: estimateRequestInput(request),
      outputReserve: request.maxOutputTokens,
    });
    expect(estimateRequestInput(request) + request.maxOutputTokens).toBeLessThanOrEqual(16000);
  } finally {
    await app.close();
  }
});
