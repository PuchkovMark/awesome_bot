import { expect, test } from 'vitest';
import { fixture, until, chat, answer } from './helpers/application-response-fixture';
test('воркер приложения заполняет сводки в SQLite, после перезапуска использует готовые фрагменты', async () => {
  const f = await fixture({ summaryIntervalMs: 30, summaryFragmentSize: 2 });
  try {
    f.complete.mockResolvedValue({ ...answer, text: 'Ира принесёт ключ.' });
    await f.storage.messages.append(f.scope, {
      chatId: chat,
      role: 'user',
      messageId: 'old-1',
      userId: 'vk:41',
      authorName: 'Ира',
      text: 'Принесу ключ.',
      timestamp: f.start - 86_400_000,
    });
    await until(() =>
      expect(
        f.db
          .prepare("SELECT count(*) FROM chat_summaries WHERE level='rolling' AND text IS NOT NULL")
          .pluck()
          .get(),
      ).toBe(1),
    );
    const count = f.complete.mock.calls.length;
    expect(count).toBe(3);
    expect(f.sends).toHaveLength(0);
    await f.restart(true);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(f.complete.mock.calls.length).toBe(count);
  } finally {
    await f.close();
  }
});
