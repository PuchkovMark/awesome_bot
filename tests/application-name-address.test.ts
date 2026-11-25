import { expect, test } from 'vitest';
import { answer, chat, fixture, group, peer } from './helpers/application-response-fixture';

test('вопросы по имени получают по одному reply после повтора каждого события VK', async () => {
  const app = await fixture();
  const questions = [
    { text: 'Пенёк, где встречаемся завтра?' },
    { text: 'Где встречаемся завтра, Пенек?' },
    { text: 'Где, Пенёк, встречаемся завтра?' },
    { text: 'пенек где встречаемся завтра' },
    { text: 'Пенёк, во сколько выходим?' },
    { text: 'Когда, Пенёк, выходим?', forwarded: true },
  ];
  try {
    for (const [index, { text, forwarded }] of questions.entries()) {
      const id = app.submit(text, 41, undefined, peer, forwarded);
      await app.published(id);
      const trace = await app.trace(id);
      expect(trace.payload).toMatchObject({
        route: { kind: 'name', mode: 'normal' },
        model: { invoked: 'yes' },
        publication: { status: 'delivered' },
      });
      const replies = () =>
        app.sends.filter((message) => message.reply_message?.conversation_message_id === id);
      expect(replies()).toEqual([
        expect.objectContaining({
          peer_id: peer,
          text: answer.text,
          reply_message: expect.objectContaining({
            peer_id: peer,
            conversation_message_id: id,
            from_id: 41,
          }),
        }),
      ]);
      expect(app.complete).toHaveBeenCalledTimes(index + 1);

      app.replay(id);
      await app.journaled(app.submit('Отмечу это в расписании.'));
      const inputs = (await app.storage.messages.list(app.scope, { limit: 100 })).filter(
        (row) => row.messageId === String(id),
      );
      expect(inputs).toEqual([
        expect.objectContaining({ chatId: chat, role: 'user', userId: 'vk:41', text }),
      ]);
      expect(replies()).toHaveLength(1);
      expect(app.complete).toHaveBeenCalledTimes(index + 1);
    }
    expect(app.sends).toHaveLength(questions.length);
  } finally {
    await app.close();
  }
});

test('в нормальной беседе обсуждение, цитата и чужой reply остаются только в журнале', async () => {
  const app = await fixture();
  try {
    const parentText = 'Посмотрю расписание.';
    const parentId = app.submit(parentText, 42);
    await app.journaled(parentId);
    const question = 'Пенёк, где встречаемся завтра?';
    const ordinaryInputs = [
      'Где Пенёк?',
      'Куда ушёл Пенёк?',
      'Почему Пенёк молчит?',
      'Где встречаемся? Пенёк приедет вечером.',
      `Ира спросила «${question}»`,
    ].map((text) => ({ id: app.submit(text), text }));
    const otherReplyId = app.submit(question, 41, {
      peer_id: peer,
      conversation_message_id: parentId,
      from_id: 42,
      date: Math.floor(app.start / 1000),
      text: parentText,
    });
    await app.journaled(app.submit('Отмечу это в расписании.'));

    const history = await app.storage.messages.list(app.scope, { limit: 100 });
    for (const { id, text } of ordinaryInputs)
      expect(history.filter((row) => row.messageId === String(id))).toEqual([
        expect.objectContaining({ chatId: chat, role: 'user', userId: 'vk:41', text }),
      ]);
    expect(history.filter((row) => row.messageId === String(otherReplyId))).toEqual([
      expect.objectContaining({
        chatId: chat,
        role: 'user',
        userId: 'vk:41',
        text: question,
        replyToMessageId: String(parentId),
      }),
    ]);
    expect(app.complete).not.toHaveBeenCalled();
    expect(app.sends).toEqual([]);
    expect(await app.storage.traces.last(app.scope)).toBeNull();

    const mentionId = app.submit(`[club${group}|Пенёк] Где встречаемся завтра?`);
    expect((await app.trace(mentionId)).payload.route?.kind).toBe('mention');
    expect(app.sends[0]?.reply_message?.conversation_message_id).toBe(mentionId);
    const botReplyId = app.submit('Во сколько выходим?', 41, app.sends[0]!);
    expect((await app.trace(botReplyId)).payload.route?.kind).toBe('reply');
    expect(app.sends[1]?.reply_message?.conversation_message_id).toBe(botReplyId);
    expect(app.complete).toHaveBeenCalledTimes(2);
  } finally {
    await app.close();
  }
});
