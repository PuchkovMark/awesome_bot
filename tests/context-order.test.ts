import { expect, test } from 'vitest';
import { openStorage } from '../src/storage/index';
import { scopeFor } from './helpers/connection-scope';
test('граница записи, курсор и ограниченная цитата независимо от timestamp', async () => {
  const s = await openStorage(':memory:');
  try {
    const scope = scopeFor(s, 'vk:a');
    const put = (messageId: string, timestamp: number, text = 'кот') =>
      s.messages.append(scope, {
        chatId: scope.chatId,
        userId: 'vk:u',
        messageId,
        timestamp,
        text,
        authorName: 'Имя',
        role: 'user',
      });
    const a = await put('a', 500, '😀'.repeat(100));
    const b = await put('b', 600);
    await put('late', 1);
    expect(
      await s.contextMessages.page(scope, { cutoffId: b.id, limit: 1, textLimit: 10 }),
    ).toMatchObject([{ id: b.id }]);
    const page = await s.contextMessages.page(scope, {
      cutoffId: b.id,
      beforeId: b.id,
      limit: 1,
      textLimit: 10,
    });
    expect(page).toMatchObject([{ id: a.id, truncated: true, text: '😀'.repeat(10) }]);
    expect(await s.contextMessages.reply(scope, 'late', b.id, 10)).toBeNull();
    expect(await s.contextMessages.reply(scope, 'a', b.id, 10)).toMatchObject({
      id: a.id,
      truncated: true,
    });
    await expect(
      s.contextMessages.page({ ...scope } as never, { cutoffId: b.id, limit: 1, textLimit: 10 }),
    ).rejects.toBeDefined();
  } finally {
    await s.close();
  }
});

test('кандидаты карточек следуют за авторами вошедших реплик и выдержки цитаты', async () => {
  const { createContextBuilder } = await import('../src/core/context/builder');
  const { contextFixture } = await import('./helpers/context');
  const f = await contextFixture();
  try {
    const human = { senderBot: false, isGroupChat: true, authorName: 'Саша Иванов' } as const;
    const excluded = await f.put('excluded', 'За окном', {
      ...human,
      userId: 'vk:46',
      timestamp: 700,
    });
    await f.put('quoted', 'Цитата '.repeat(200), { ...human, userId: 'vk:44', timestamp: 100 });
    await f.put('removed-by-page', 'Старый участник', {
      ...human,
      userId: 'vk:48',
      timestamp: 500,
    });
    await f.put('same-author', 'Первая реплика', { ...human, userId: 'vk:42', timestamp: 150 });
    await f.put('recent', 'Вторая реплика', { ...human, userId: 'vk:42', timestamp: 220 });
    await f.put('twin', 'Реплика тёзки', { ...human, userId: 'vk:43', timestamp: 220 });
    await f.put('robot', 'Старый вход бота', {
      ...human,
      senderBot: true,
      userId: 'vk:-314',
      timestamp: 300,
    });
    const item = await f.put('trigger', 'Вопрос с упоминанием [id48|Другой]', {
      ...human,
      userId: 'vk:41',
      timestamp: 400,
      replyToMessageId: 'quoted',
    });
    let reads = 0;
    const builder = createContextBuilder({
      ...f.options,
      config: { ...f.options.config, maxHistoryMessages: 5, replyTextCodePoints: 40 },
      participantCards: {
        read() {
          reads++;
          return { facts: [] };
        },
        current: () => true,
      },
    });
    const ready = await builder.prepare(f.work(item.id));
    expect(ready.kind).toBe('ready');
    if (ready.kind !== 'ready') return;
    expect(ready.metadata.reply).toBe('truncated');
    expect(ready.metadata.messageIds).not.toContain(excluded.id);
    expect(reads).toBe(0);
    const data = JSON.parse(ready.input.messages[0]!.text);
    const byName = [data.current, ...data.history, data.reply] as { authorLabel: string }[];
    const authors = ready.participantCards!.candidates;
    expect(authors.map(({ userId }) => userId)).toEqual(['vk:41', 'vk:43', 'vk:42', 'vk:44']);
    expect(new Set(authors.map(({ authorLabel }) => authorLabel)).size).toBe(4);
    expect(
      authors.every(({ authorLabel }) => byName.some((value) => value.authorLabel === authorLabel)),
    ).toBe(true);
  } finally {
    await f.storage.close();
  }
});
