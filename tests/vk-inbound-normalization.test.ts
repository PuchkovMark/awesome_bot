import { describe, expect, it } from 'vitest';
import { normalizeVkIncoming, parseVkIncoming } from '../src/channels/vk/normalize';

const groupId = 314;
const peer = 2_000_000_004;

function event(fields: Record<string, unknown> = {}) {
  return { type: 'message_new', group_id: groupId, object: { message: {
    peer_id: peer, from_id: 73, conversation_message_id: 8, date: 1_700_000_000, id: 0, out: 0, text: 'Привет ☀', ...fields,
  } } };
}

function parse(fields: Record<string, unknown> = {}) {
  const parsed = parseVkIncoming(event(fields), groupId);
  if (parsed.kind !== 'message') throw new Error('Expected test message');
  return parsed.message;
}

describe('нормализация входящего сообщения VK', () => {
  it.each([[2_000_000_000, true], [1_999_999_999, false], [-73, false]])('определяет область peer %s', (peerId, group) => {
    expect(normalizeVkIncoming(parse({ peer_id: peerId, id: 991 }), groupId)).toMatchObject({
      chatId: `vk:${peerId}`, userId: 'vk:73', isGroupChat: group, timestamp: 1_700_000_000_000,
      messageId: '8', text: 'Привет ☀', isMentioned: false, authorName: '', isBot: 'unknown', isAdmin: 'unknown', attachments: [],
    });
  });

  it('удаляет только размеченное упоминание своего сообщества', () => {
    const text = '[club314|Бот] Привет, [club3140|Другой] и @club314 🌿';
    expect(normalizeVkIncoming(parse({ text }), groupId)).toMatchObject({
      text: 'Привет, [club3140|Другой] и @club314 🌿', isMentioned: true,
    });
    expect(parse({ text: '  Бот, [club314|\nТекст]  ' }).text).toBe('  Бот, [club314|\nТекст]  ');
  });

  it('извлекает только тип вложения и допускает пустой текст', () => {
    const parsed = parse({ text: '', attachments: [{ type: 'doc', doc: { url: 'private' } }, { type: 'future' }, null] });
    expect(normalizeVkIncoming(parsed, groupId).attachments).toEqual([{ kind: 'doc' }, { kind: 'unknown' }, { kind: 'unknown' }]);
  });

  it.each([[-groupId, true], [73, false], [undefined, false]])('связывает подтверждённый ответ c автором %s', (from, toBot) => {
    const parsed = parse({ reply_message: { peer_id: peer, from_id: from, conversation_message_id: 7, id: 991 } });
    expect(normalizeVkIncoming(parsed, groupId)).not.toHaveProperty('replyToMessageId');
    expect(normalizeVkIncoming(parsed, groupId, { verifiedReply: { cmid: 7, authorId: from } }))
      .toMatchObject({ replyToMessageId: '7', isReplyToBot: toBot });
  });

  it('требует подтверждения reply, если родитель пришёл в другой адресации', () => {
    const parsed = parse({ reply_message: { peer_id: 2_000_000_122, from_id: -groupId, conversation_message_id: 7 } });
    expect(normalizeVkIncoming(parsed, groupId)).not.toHaveProperty('replyToMessageId');
    expect(normalizeVkIncoming(parsed, groupId, { verifiedReply: { cmid: 6, authorId: -groupId } }).isReplyToBot).toBe(false);
    expect(normalizeVkIncoming(parsed, groupId, { verifiedReply: { cmid: 7, authorId: -groupId } })).toMatchObject({
      replyToMessageId: '7', isReplyToBot: true,
    });
    expect(normalizeVkIncoming(parse({ reply_message: { peer_id: peer, id: 991 } }), groupId)).not.toHaveProperty('replyToMessageId');
    expect(normalizeVkIncoming(parse({ reply_message: { peer_id: peer, conversation_message_id: 8 } }), groupId))
      .not.toHaveProperty('replyToMessageId');
  });

  it('сохраняет подтверждённые признаки автора', () => {
    expect(normalizeVkIncoming(parse(), groupId, { authorName: 'Женя', isAdmin: false, isBot: false }))
      .toMatchObject({ authorName: 'Женя', isAdmin: false, isBot: false });
    expect(normalizeVkIncoming(parse({ from_id: -groupId }), groupId).isBot).toBe(true);
  });

  it.each([{ from_id: 0 }, { peer_id: '123' }, { text: undefined }, { date: Number.MAX_SAFE_INTEGER },
    { conversation_message_id: undefined, id: 991 }, { conversation_message_id: 0 }, { out: 5 }])('отбрасывает неверные обязательные данные %o', fields => {
    expect(parseVkIncoming(event(fields), groupId)).toEqual({ kind: 'invalid' });
  });

  it('отделяет служебные, исходящие и относящиеся к другому сообществу события', () => {
    for (const ignored of [
      event({ action: { type: 'chat_title_update' } }),
      event({ peer_id: 73, action: { type: 'chat_invite_user' } }), event({ out: 1 }),
      { ...event(), type: 'message_edit' }, { ...event(), group_id: groupId + 1 },
    ]) expect(parseVkIncoming(ignored, groupId)).toEqual({ kind: 'ignored' });
  });
});

describe('служебные действия участия VK', () => {
  it.each([
    ['chat_invite_user', 73, 84, 'invited'],
    ['chat_invite_user_by_link', 73, 73, 'joined'],
    ['chat_kick_user', 73, 73, 'left'],
    ['chat_kick_user', 73, 84, 'removed'],
    ['chat_kick_user', undefined, 84, 'unknown'],
    ['chat_kick_user', 73, undefined, 'unknown'],
    ['chat_invite_user_by_message_request', 73, 84, 'unknown'],
  ] as const)('нормализует %s (%s, %s) как %s', (type, actor, subject, change) => {
    expect(parseVkIncoming(event({ text: undefined, out: 1, from_id: actor,
      action: { type, member_id: subject } }), groupId)).toEqual({
      kind: 'membership', chatId: `vk:${peer}`, affectsConnection: false, signalKey: '8',
      event: {
        kind: 'membership', chatId: `vk:${peer}`, timestamp: 1_700_000_000_000, eventId: '8', change,
        actorId: actor === undefined ? null : `vk:${actor}`,
        subjectId: subject === undefined ? null : `vk:${subject}`,
      },
    });
  });

  it('сохраняет исходный ID события и область локального номера', () => {
    const invite = event({ action: { type: 'chat_invite_user', member_id: -groupId } });
    expect(parseVkIncoming({ ...invite, event_id: 'event-abc' }, groupId)).toMatchObject({
      chatId: `vk:${peer}`, affectsConnection: true, signalKey: '8',
      event: { eventId: 'event-abc', subjectId: `vk:${-groupId}` },
    });
    expect(parseVkIncoming(event({ peer_id: peer + 1, action: { type: 'chat_invite_user', member_id: -groupId } }), groupId))
      .toMatchObject({ chatId: `vk:${peer + 1}`, signalKey: '8' });
  });

  it('обрабатывает событие без идентификаторов и сохраняет сигнал о боте при неизвестном времени', () => {
    const noId = parseVkIncoming(event({ conversation_message_id: undefined, from_id: undefined,
      action: { type: 'chat_kick_user' } }), groupId);
    expect(noId).toMatchObject({ signalKey: undefined, event: { actorId: null, subjectId: null, change: 'unknown' } });
    expect(noId).not.toHaveProperty('event.eventId');
    expect(parseVkIncoming(event({ date: 'bad', action: { type: 'chat_kick_user', member_id: -groupId } }), groupId))
      .toEqual({ kind: 'membership', chatId: `vk:${peer}`, affectsConnection: true, signalKey: '8', event: undefined });
    expect(parseVkIncoming(event({ date: 'bad', action: { type: 'chat_kick_user', member_id: 84 } }), groupId))
      .toEqual({ kind: 'invalid' });
  });
});

it('считает повторные метки сообщества одним адресатом и не берёт адресатов из цитаты', () => {
  const parent={conversation_message_id:7,from_id:88,text:'[id99|Другой]'};
  const one=parse({text:'[club314|Бот] [public314|Бот] Вопрос',reply_message:parent});
  expect(normalizeVkIncoming(one,groupId,{verifiedReply:{cmid:7,authorId:88}}))
    .toMatchObject({isMentioned:true,soleBotMention:true,replyAddress:'other',replyToMessageId:'7'});
  const two=parse({text:'[club314|Бот] [id99|Другой] Вопрос',reply_message:parent});
  expect(two).toMatchObject({isMentioned:true,soleBotMention:false});
  expect(normalizeVkIncoming(parse({reply_message:{id:77}}),groupId)).toMatchObject({replyAddress:'unknown'});
});
