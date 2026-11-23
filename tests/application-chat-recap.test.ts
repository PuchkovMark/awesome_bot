import { applicationSummaries } from '../src/app/chat-summaries';
import { tokenBudgetStore } from '../src/storage/token-budget-store';
import { expect, test } from 'vitest';
import { fixture, until, chat, answer } from './helpers/application-response-fixture';
const question = '[club314|Пенёк] Что было вчера?';
test('сначала служебный reply, затем сводка Haiku; повторный вопрос использует готовый день', async () => {
  const f = await fixture();
  try {
    await f.storage.messages.append(f.scope, {
      chatId: chat,
      messageId: 'yesterday',
      userId: 'vk:41',
      role: 'user',
      authorName: 'Ира',
      text: 'Встречаемся у дуба.',
      timestamp: f.start - 86_400_000,
    });
    f.complete.mockImplementation(async () => {
      expect(f.sends.some((row) => row.text === 'собираю, минутку')).toBe(true);
      return { ...answer, text: 'Встречаемся у дуба.' };
    });
    const first = f.submit(question);
    await until(() =>
      expect(
        f.sends.some(
          (row) =>
            row.text === 'Встречаемся у дуба.' &&
            row.reply_message?.conversation_message_id === first,
        ),
      ).toBe(true),
    );
    const count = f.complete.mock.calls.length;
    expect(count).toBe(2);
    expect(
      f.db.prepare("SELECT purpose FROM messages WHERE text='собираю, минутку'").pluck().get(),
    ).toBe('service_notice');
    const next = f.submit(question);
    await until(() =>
      expect(
        f.sends.some(
          (row) =>
            row.text === 'Встречаемся у дуба.' &&
            row.reply_message?.conversation_message_id === next,
        ),
      ).toBe(true),
    );
    expect(f.complete.mock.calls).toHaveLength(count);
    expect(f.sends.filter((row) => row.text === 'собираю, минутку')).toHaveLength(1);
  } finally {
    await f.close();
  }
});

async function appendSource(f: Awaited<ReturnType<typeof fixture>>, name: string, minutes: number) {
  return f.storage.messages.append(f.scope, {
    chatId: chat,
    messageId: name,
    userId: 'vk:41',
    role: 'user',
    authorName: 'Ира',
    text: name,
    timestamp: f.start - 86400000 + minutes * 60000,
  });
}
test('точный интервал и неизвестная доставка промежуточного reply сохраняют один полезный результат', async () => {
  const f = await fixture();
  try {
    await appendSource(f, 'За пределами', -1);
    await appendSource(f, 'Нужное решение', 0);
    await appendSource(f, 'Верхняя граница', 1);
    f.failSend((text) => (text === 'собираю, минутку' ? 'unknownAfterDelivery' : undefined));
    f.complete.mockImplementation(async (request) => {
      expect(request.messages[0]!.text).toContain('Нужное решение');
      expect(request.messages[0]!.text).not.toMatch(/За пределами|Верхняя граница/u);
      return { ...answer, text: 'Нужное решение' };
    });
    const id = f.submit('[club314|Пенёк] Дай сводку с 2026-11-22T12:00Z по 2026-11-22T12:01Z');
    await until(() =>
      expect(
        f.sends.some(
          (row) =>
            row.text === 'Нужное решение' && row.reply_message?.conversation_message_id === id,
        ),
      ).toBe(true),
    );
    expect(f.sends.filter((row) => row.text === 'собираю, минутку')).toHaveLength(1);
    expect(f.db.prepare('SELECT delivered FROM chat_summary_notices').pluck().get()).toBe(0);
  } finally {
    await f.close();
  }
});

test('удаление источника после промежуточного reply удерживает текст пересказа', async () => {
  const f = await fixture();
  try {
    const source = await appendSource(f, 'Личное сообщение', 0);
    f.complete.mockImplementation(async () => {
      expect(f.sends.some((row) => row.text === 'собираю, минутку')).toBe(true);
      f.db.prepare('DELETE FROM messages WHERE id=?').run(source.id);
      return { ...answer, text: 'Закрытый текст' };
    });
    const id = f.submit(question);
    await until(async () =>
      expect((await f.trace(id)).payload.publication.status).not.toBe('pending_checks'),
    );
    expect(f.sends.filter((row) => row.text === 'Закрытый текст')).toHaveLength(0);
    expect(f.db.prepare('SELECT count(*) FROM chat_summaries').pluck().get()).toBe(0);
  } finally {
    await f.close();
  }
});

test('при нехватке токенов пересказ сообщает о частичном покрытии, а пустой день обходится без модели', async () => {
  const f = await fixture({ summaryFragmentSize: 1 });
  try {
    const empty = f.submit(question);
    await until(() =>
      expect(
        f.sends.some(
          (row) =>
            row.reply_message?.conversation_message_id === empty &&
            row.text.includes('нет доступных'),
        ),
      ).toBe(true),
    );
    expect(f.complete).not.toHaveBeenCalled();
    await appendSource(f, 'Первое решение', 0);
    await appendSource(f, 'Второе решение', 1);
    tokenBudgetStore(f.storage).update(f.scope, true, { total: 2300 }, f.start);
    f.complete.mockResolvedValue({
      ...answer,
      text: 'Первое решение',
      usage: { input: 1200, output: 300 },
    });
    const id = f.submit(question);
    await until(() =>
      expect(
        f.sends.some(
          (row) =>
            row.reply_message?.conversation_message_id === id &&
            row.text.includes('часть переписки') &&
            row.text.includes('Первое решение'),
        ),
      ).toBe(true),
    );
    expect(f.complete).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

test.each(['receipt', 'unknown'])(
  'штатный порт с исходом %s ведёт служебный журнал по квитанции и сохраняет финальный пересказ',
  async (delivery) => {
    const f = await fixture();
    try {
      await appendSource(f, 'Подтверждённое решение', 0);
      const source = await f.storage.messages.append(f.scope, {
        chatId: chat,
        userId: 'vk:41',
        authorName: 'Ира',
        text: question,
        role: 'user',
        messageId: 'synthetic-question',
        timestamp: f.start,
      });
      const signal = new AbortController().signal;
      const service = applicationSummaries({
        storage: f.storage,
        model: 'synthetic',
        client: {
          async complete() {
            return { ...answer, text: 'Подтверждённое решение' };
          },
        },
        sessionSecret: 'synthetic',
        intervalMs: 300000,
        fragmentSize: 250,
        modelContext: 16000,
        inputBudget: 8000,
        signal,
        platform: 'vk',
        group: () => true,
        disclosure: () => 1,
        backgroundReady: () => true,
        port: {
          async canReply() {
            return true;
          },
          async publish() {
            if (delivery === 'unknown') throw Error('Квитанция недоступна');
            return {
              kind: 'delivered',
              receipt: {
                messageId: 'synthetic-status',
                userId: 'vk:314',
                authorName: 'Бот',
                timestamp: f.start,
              },
            };
          },
        },
      });
      const result = await service.answer({
        scope: f.scope,
        messageId: source.id,
        signal,
        route: { kind: 'mention', isGroupChat: true, mode: 'normal' },
        isCurrent: () => true,
        jobId: 1,
        recordTrace() {},
        admitModelAttempt: () => true,
      });
      expect(result?.result).toMatchObject({ kind: 'complete', text: 'Подтверждённое решение' });
      expect(f.db.prepare('SELECT delivered FROM chat_summary_notices').pluck().get()).toBe(
        delivery === 'receipt' ? 1 : 0,
      );
      expect(
        f.db
          .prepare("SELECT purpose FROM messages WHERE platform_message_id='synthetic-status'")
          .pluck()
          .get(),
      ).toBe(delivery === 'receipt' ? 'service_notice' : undefined);
    } finally {
      await f.close();
    }
  },
);
