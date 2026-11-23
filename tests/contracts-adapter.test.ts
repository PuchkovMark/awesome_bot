import { describe, expect, test } from 'vitest';
import type { ChannelAdapter, IncomingEvent, OutgoingMessage } from '../src/contracts/index';
import { FakeAdapter } from './helpers/fake-adapters';

describe.each(['test-a', 'test-b'] as const)('адаптер %s', (platform) => {
  test('передаёт оба вида событий и ожидает обработчик', async () => {
    const events: IncomingEvent[] = [
      {
        kind: 'message',
        chatId: `${platform}:chat`,
        userId: `${platform}:known`,
        authorName: 'Имя',
        isGroupChat: true,
        isAdmin: 'unknown',
        isBot: 'unknown',
        text: 'Привет 🐈',
        messageId: '1',
        isReplyToBot: false,
        isMentioned: false,
        timestamp: 0,
        attachments: [],
      },
      {
        kind: 'membership',
        chatId: `${platform}:chat`,
        subjectId: null,
        actorId: null,
        change: 'unknown',
        timestamp: 1,
      },
    ];
    const adapter: ChannelAdapter = new FakeAdapter(platform, events);
    const received: IncomingEvent[] = [];
    await adapter.start(async (event) => {
      await Promise.resolve();
      received.push(event);
    });
    expect(received).toEqual(events);
  });

  test('передаёт исходящий текст, reply и операции общего интерфейса', async () => {
    const fake = new FakeAdapter(platform);
    const adapter: ChannelAdapter = fake;
    const message: OutgoingMessage = {
      chatId: `${platform}:chat`,
      text: 'Ответ 🐈',
      replyToMessageId: 'incoming-1',
    };
    const ids = await adapter.send(message);
    expect(fake.sent).toEqual([message]);
    expect(ids).toEqual(platform === 'test-a' ? ['part-1'] : ['part-1', 'part-2']);
    await adapter.sendTyping(message.chatId);
    expect(fake.typing).toEqual([message.chatId]);
    expect(await adapter.getUserName(`${platform}:known`)).toBe(`Имя ${platform}`);
    expect(await adapter.getUserName(`${platform}:missing`)).toBeNull();
  });

  test('сохраняет область снимка, неполноту и различия платформ', async () => {
    const adapter: ChannelAdapter = new FakeAdapter(platform);
    const first = await adapter.capabilities({
      chatId: `${platform}:one`,
      userId: `${platform}:known`,
    });
    const second = await adapter.capabilities({
      chatId: `${platform}:two`,
      userId: `${platform}:other`,
    });
    const chatOnly = await adapter.capabilities({ chatId: `${platform}:one` });
    expect(first.context).toEqual({ chatId: `${platform}:one`, userId: `${platform}:known` });
    expect(second.context).toEqual({ chatId: `${platform}:two`, userId: `${platform}:other` });
    expect(first.observedAt).toBe(1_700_000_000_000);
    expect(first.support.directMessage).toBe('supported');
    expect(second.support.directMessage).toBe('unknown');
    expect(chatOnly.support.directMessage).toBe('unknown');
    expect(first.support.adminInfo).toBe('unknown');
    expect(first.support.typing).toBe(platform === 'test-a' ? 'supported' : 'unsupported');
    expect(first.maxMessageLength).toEqual(
      platform === 'test-a' ? { value: 100, unit: 'utf16' } : { value: 200, unit: 'utf8Bytes' },
    );
    expect(first.textFormats).toEqual(platform === 'test-a' ? ['plain'] : ['plain', 'markdown']);
  });
});
