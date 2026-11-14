import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import OpenAI from 'openai';
import type { AITool } from '../src/services/ai/AIProvider.js';
import type {
  MessageDeliveryContext,
  MessageReplyOptions,
} from '../src/services/ai/tools/messageDeliveryTool.js';

process.env.VK_TOKEN = 'test-token';
process.env.VK_GROUP_ID = '1';
process.env.LOG_LEVEL = 'silent';

const { AiMessageDeliveryGuard, createMessageDeliveryTool } =
  await import('../src/services/ai/tools/messageDeliveryTool.js');
const { sendChatCompletion } = await import('../src/services/ai/chatCompletion.js');
const { default: detectorService } = await import('../src/services/detector/detectorService.js');
const { SenderService } = await import('../src/services/sender/senderService.js');

const peerId = 2_000_000_042;
const now = Date.parse('2026-11-10T23:54:34Z');

type Member = { id: number; first: string; last: string; screenName?: string };
type Result = { status: string; message?: string; delivery?: string; limitation?: string };
type SentMessage = { text: string; options: MessageReplyOptions };

function memberPage(members: Member[], count = members.length) {
  return {
    count,
    items: members.map((member) => ({ member_id: member.id })),
    profiles: members.map((member) => ({
      id: member.id,
      first_name: member.first,
      last_name: member.last,
      screen_name: member.screenName,
    })),
    groups: [],
  };
}

function recentMessage(id: number, authorId: number, ageSeconds = 60) {
  return {
    peer_id: peerId,
    conversation_message_id: id,
    from_id: authorId,
    date: Math.floor(now / 1000) - ageSeconds,
    is_hidden: false,
  };
}

function harness(
  options: {
    members?: Member[];
    messages?: unknown[];
    failAfterSend?: boolean;
    overrides?: Partial<MessageDeliveryContext>;
  } = {},
) {
  const members = options.members ?? [
    { id: 7, first: 'Андрей', last: 'Петров', screenName: 'andrey' },
    { id: 8, first: 'Ирина', last: 'Иванова' },
  ];
  const sent: SentMessage[] = [];
  const memberRequests: Array<{ offset: number; count: number }> = [];
  const messageRequests: number[][] = [];
  let actionStarted = false;
  const guard = new AiMessageDeliveryGuard();
  const context: MessageDeliveryContext = {
    peerId,
    senderId: '5',
    isChat: true,
    currentMessage: { replyTo: 900, conversationMessageId: 100 },
    quotedMessage: { peerId, replyTo: 888, conversationMessageId: 88 },
    checkAccess: async () => ({ allowed: true }),
    beginAction: () => {
      if (actionStarted) return 'Другое действие уже начато.';
      actionStarted = true;
      return null;
    },
    getAnchorMessageId: async () => 100,
    getMembers: async (offset, count) => {
      memberRequests.push({ offset, count });
      return memberPage(members.slice(offset, offset + count), members.length);
    },
    getMessages: async (ids) => {
      messageRequests.push(ids);
      return { items: options.messages ?? [] };
    },
    deliver: async (text, reply) => {
      try {
        await guard.attempt(async () => {
          sent.push({ text, options: reply });
          if (options.failAfterSend) throw new Error('delivery timed out');
        });
        return { status: 'result', message: 'Отправлено.' };
      } catch {
        return { status: 'uncertain', message: 'Отправка могла выполниться.' };
      }
    },
    now: () => now,
    ...options.overrides,
  };
  return {
    context,
    tool: createMessageDeliveryTool(context),
    guard,
    sent,
    memberRequests,
    messageRequests,
    get actionStarted() {
      return actionStarted;
    },
  };
}

async function execute(tool: AITool, args: unknown): Promise<Result> {
  return JSON.parse(await tool.execute(args));
}

test('VK sender sends a single message with the chosen conversation reply ID', async () => {
  const calls: Array<{ peer_id: number; message: string; forward?: string }> = [];
  const sender = new SenderService();
  Reflect.set(sender, 'vk', {
    api: {
      messages: {
        send: async (params: { peer_id: number; message: string; forward?: string }) => {
          calls.push(params);
          return 777;
        },
      },
    },
  });
  await sender.send(peerId, 'x'.repeat(4100), {
    replyTo: 900,
    conversationMessageId: 99,
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].message.length <= 4000);
  assert.equal(typeof calls[0].forward, 'string');
  assert.deepEqual(JSON.parse(calls[0].forward ?? ''), {
    conversation_message_ids: 99,
    peer_id: peerId,
    is_reply: true,
  });
  assert.equal(sender.isBotMessage(peerId, 777), true);

  await sender.send(peerId, '[id7|Андрей Петров] Привет!');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].forward, undefined);
});

test('a mention or a reply to the bot produces one reply to the current message', async () => {
  for (const [incoming, isReplyToBot] of [
    ['Пенёк, привет', false],
    ['Привет', true],
  ] as const) {
    assert.equal(detectorService.isAddressed(incoming, isReplyToBot), true);
    const h = harness();
    const result = await execute(h.tool, { mode: 'reply_to_current', text: 'Привет!' });
    if (!h.guard.hasAttempted) {
      await h.guard.attempt(async () => {
        h.sent.push({ text: 'Привет!', options: h.context.currentMessage });
      });
    }
    assert.equal(result.status, 'result');
    assert.deepEqual(h.sent, [{ text: 'Привет!', options: { conversationMessageId: 100 } }]);
  }
});

test('a message to a participant replies to that person’s latest nearby VK message', async () => {
  const h = harness({
    messages: [recentMessage(97, 7), recentMessage(99, 7, 120), recentMessage(98, 8)],
  });
  const result = await execute(h.tool, {
    mode: 'reply_to_member',
    recipient: 'Андрею',
    text: 'Ты молодец!',
  });
  assert.equal(result.status, 'result');
  assert.equal(result.delivery, 'reply_to_member');
  assert.deepEqual(h.sent, [{ text: 'Ты молодец!', options: { conversationMessageId: 99 } }]);
  assert.deepEqual(
    h.messageRequests[0],
    Array.from({ length: 20 }, (_, index) => 99 - index),
  );
  assert.equal(h.memberRequests.length, 1);
});

test('a missing, old, or hidden nearby message becomes one separate mention', async () => {
  const hidden = { ...recentMessage(99, 7), is_hidden: true };
  for (const messages of [[], [recentMessage(99, 7, 31 * 60)], [hidden]]) {
    const h = harness({ messages });
    const result = await execute(h.tool, {
      mode: 'reply_to_member',
      recipient: 'Андрей',
      text: 'Ты молодец!',
    });
    assert.equal(result.status, 'result');
    assert.equal(result.delivery, 'mention_member');
    assert.deepEqual(h.sent, [{ text: '[id7|Андрей Петров] Ты молодец!', options: {} }]);
  }
});

test('an explicit mention does not inspect history or reply to the request', async () => {
  const h = harness({ messages: [recentMessage(99, 7)] });
  const result = await execute(h.tool, {
    mode: 'mention_member',
    recipient: '@andrey',
    text: 'Ты молодец!',
  });
  assert.equal(result.status, 'result');
  assert.equal(h.messageRequests.length, 0);
  assert.deepEqual(h.sent, [{ text: '[id7|Андрей Петров] Ты молодец!', options: {} }]);
});

test('an exact full name takes precedence over a similar inflected name', async () => {
  const h = harness({
    members: [
      { id: 7, first: 'Андрей', last: 'Петров' },
      { id: 9, first: 'Андрейка', last: 'Сидоров' },
    ],
  });
  const result = await execute(h.tool, {
    mode: 'mention_member',
    recipient: 'Андрей Петров',
    text: 'Привет!',
  });
  assert.equal(result.status, 'result');
  assert.deepEqual(h.sent, [{ text: '[id7|Андрей Петров] Привет!', options: {} }]);
});

test('ambiguous names require a new user clarification and cannot be bypassed in the same turn', async () => {
  const h = harness({
    members: [
      { id: 7, first: 'Андрей', last: 'Петров' },
      { id: 9, first: 'Андрей', last: 'Сидоров' },
    ],
  });
  const result = await execute(h.tool, {
    mode: 'reply_to_member',
    recipient: 'Андрею',
    text: 'Ты молодец!',
  });
  assert.equal(result.status, 'clarification_requested');
  assert.equal(h.actionStarted, true);
  assert.equal(h.messageRequests.length, 0);
  assert.equal(
    (await execute(h.tool, { mode: 'send', text: 'Андрей, ты молодец!' })).status,
    'not_executed',
  );
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].text, /несколько участников/iu);
  assert.deepEqual(h.sent[0].options, { conversationMessageId: 100 });
});

test('checks every member page before accepting an otherwise ambiguous first name', async () => {
  const members = Array.from({ length: 501 }, (_, index) => ({
    id: index + 10,
    first: index === 0 || index === 500 ? 'Андрей' : `Участник${index}`,
    last: `Фамилия${index}`,
  }));
  const h = harness({ members });
  const result = await execute(h.tool, {
    mode: 'mention_member',
    recipient: 'Андрей',
    text: 'Привет!',
  });
  assert.equal(result.status, 'clarification_requested');
  assert.equal(h.memberRequests.length, 2);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].text, /несколько участников/iu);
});

test('does not guess names when VK omits participant profiles', async () => {
  const h = harness({
    members: [
      { id: 7, first: 'Андрей', last: 'Петров' },
      { id: 8, first: '', last: '' },
    ],
  });
  const result = await execute(h.tool, {
    mode: 'mention_member',
    recipient: 'Андрей',
    text: 'Привет!',
  });
  assert.equal(result.status, 'clarification_requested');
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].text, /упоминани/iu);
});

test('accepts an explicit VK ID only for a current member', async () => {
  const h = harness();
  const notMember = await execute(h.tool, {
    mode: 'mention_member',
    recipient: '[id999|Андрей]',
    text: 'Привет!',
  });
  assert.equal(notMember.status, 'clarification_requested');
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].text, /не найден/iu);
  const memberHarness = harness();
  const member = await execute(memberHarness.tool, {
    mode: 'mention_member',
    recipient: '[id7|Андрей]',
    text: 'Привет!',
  });
  assert.equal(member.status, 'result');
  assert.deepEqual(memberHarness.sent, [{ text: '[id7|Андрей Петров] Привет!', options: {} }]);
});

test('a quoted message is selectable only from the current conversation', async () => {
  const allowed = harness();
  assert.equal(
    (await execute(allowed.tool, { mode: 'reply_to_quoted', text: 'Ответ.' })).status,
    'result',
  );
  assert.deepEqual(allowed.sent, [{ text: 'Ответ.', options: { conversationMessageId: 88 } }]);

  const otherPeer = harness({
    overrides: { quotedMessage: { peerId: peerId + 1, conversationMessageId: 88 } },
  });
  assert.equal(
    (await execute(otherPeer.tool, { mode: 'reply_to_quoted', text: 'Ответ.' })).status,
    'not_executed',
  );
  assert.equal(otherPeer.sent.length, 0);
});

test('does not silently send a plain message when the requested reply ID is unavailable', async () => {
  const h = harness({ overrides: { currentMessage: {} } });
  const result = await execute(h.tool, { mode: 'reply_to_current', text: 'Привет!' });
  assert.equal(result.status, 'not_executed');
  assert.equal(h.sent.length, 0);
  assert.equal(h.actionStarted, false);
});

test('private dialogs are bound to their author and cannot address other members', async () => {
  const direct = harness({
    overrides: { peerId: 5, isChat: false, currentMessage: { replyTo: 42 } },
  });
  const denied = await execute(direct.tool, {
    mode: 'mention_member',
    recipient: '[id7|Андрей]',
    text: 'Привет!',
  });
  assert.equal(denied.status, 'not_executed');
  assert.equal(direct.memberRequests.length, 0);
  const sent = await execute(direct.tool, { mode: 'reply_to_current', text: 'Привет!' });
  assert.equal(sent.status, 'result');
  assert.deepEqual(direct.sent, [{ text: 'Привет!', options: { replyTo: 42 } }]);

  const otherDirect = harness({ overrides: { peerId: 6, isChat: false } });
  assert.equal(
    (await execute(otherDirect.tool, { mode: 'send', text: 'Привет!' })).status,
    'not_executed',
  );
  assert.equal(otherDirect.sent.length, 0);
});

test('rejects invented peers, malformed payloads, and manual mass mentions', async () => {
  const h = harness();
  for (const input of [
    { mode: 'send', text: 'Привет!', peer_id: peerId + 1 },
    { mode: 'send', text: '@all привет' },
    { mode: 'send', text: '[id999|Андрей], привет' },
    { mode: 'send', text: ' ' },
    { mode: 'send', text: 'x'.repeat(4001) },
    { mode: 'send', text: 'Привет!', recipient: 'Андрей' },
    { mode: 'mention_member', text: 'Привет!' },
  ]) {
    assert.equal((await execute(h.tool, input)).status, 'not_executed');
  }
  assert.equal(h.memberRequests.length, 0);
  assert.equal(h.sent.length, 0);
  assert.equal(h.actionStarted, false);
});

test('rechecks access immediately before sending after participant lookup', async () => {
  let checks = 0;
  const h = harness({
    messages: [recentMessage(99, 7)],
    overrides: {
      checkAccess: async () =>
        ++checks === 1 ? { allowed: true } : { allowed: false, message: 'Режим беседы изменился.' },
    },
  });
  const result = await execute(h.tool, {
    mode: 'reply_to_member',
    recipient: 'Андрей',
    text: 'Привет!',
  });
  assert.equal(result.status, 'not_executed');
  assert.match(result.message ?? '', /режим/iu);
  assert.equal(h.sent.length, 0);
  assert.equal(h.actionStarted, false);
});

test('does not look up or send a message when active mode or another action forbids it', async () => {
  const h = harness({
    overrides: {
      checkAccess: async () => ({ allowed: false, message: 'Сначала реши, отвечать ли.' }),
    },
  });
  const result = await execute(h.tool, {
    mode: 'reply_to_member',
    recipient: 'Андрей',
    text: 'Привет!',
  });
  assert.equal(result.status, 'not_executed');
  assert.equal(h.memberRequests.length, 0);
  assert.equal(h.sent.length, 0);

  const historyBlocked = harness({
    overrides: { beginAction: () => 'После чтения истории действие недоступно.' },
  });
  assert.equal(
    (await execute(historyBlocked.tool, { mode: 'reply_to_current', text: 'Привет!' })).status,
    'not_executed',
  );
  assert.equal(historyBlocked.sent.length, 0);
});

test('a failed member lookup reports one error without sending to a guessed recipient', async () => {
  const h = harness({
    overrides: {
      getMembers: async () => {
        throw new Error('VK unavailable');
      },
    },
  });
  const result = await execute(h.tool, {
    mode: 'mention_member',
    recipient: 'Андрей',
    text: 'Привет!',
  });
  assert.equal(result.status, 'error');
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].text, /не удалось проверить/iu);
  assert.equal(h.actionStarted, true);
});

test('a failed or cross-conversation history lookup falls back to a safe mention', async () => {
  for (const getMessages of [
    async () => {
      throw new Error('history unavailable');
    },
    async () => ({ items: [{ ...recentMessage(99, 7), peer_id: peerId + 1 }] }),
  ]) {
    const h = harness({ overrides: { getMessages } });
    const result = await execute(h.tool, {
      mode: 'reply_to_member',
      recipient: 'Андрей',
      text: 'Привет!',
    });
    assert.equal(result.status, 'result');
    assert.match(result.limitation ?? '', /проверить не удалось/iu);
    assert.deepEqual(h.sent, [{ text: '[id7|Андрей Петров] Привет!', options: {} }]);
  }
});

test('an uncertain send cannot be retried or followed by an automatic duplicate', async () => {
  const h = harness({ failAfterSend: true });
  const result = await execute(h.tool, { mode: 'reply_to_current', text: 'Привет!' });
  assert.equal(result.status, 'uncertain');
  assert.equal(h.guard.hasAttempted, true);
  assert.equal(
    (await execute(h.tool, { mode: 'reply_to_current', text: 'Привет!' })).status,
    'not_executed',
  );
  if (!h.guard.hasAttempted) {
    await h.guard.attempt(async () => {
      h.sent.push({ text: 'Привет!', options: h.context.currentMessage });
    });
  }
  assert.equal(h.sent.length, 1);
});

async function runToolCompletion(
  h: ReturnType<typeof harness>,
  finalStatus: 200 | 500,
): Promise<{ answer?: string; toolResults: Result[] }> {
  let requests = 0;
  const toolResults: Result[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requests += 1;
      const requestBody: {
        messages: Array<{ role: string; content?: string }>;
        tools?: Array<{ function: { name: string } }>;
      } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (requests === 1) {
        assert.ok(requestBody.tools?.some((entry) => entry.function.name === 'send_vk_message'));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            id: 'tool-call',
            choices: [
              {
                index: 0,
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [1, 2].map((id) => ({
                    id: `send-${id}`,
                    type: 'function',
                    function: {
                      name: 'send_vk_message',
                      arguments: JSON.stringify({ mode: 'reply_to_current', text: 'Привет!' }),
                    },
                  })),
                },
              },
            ],
          }),
        );
        return;
      }
      for (const message of requestBody.messages.filter((entry) => entry.role === 'tool')) {
        if (message.content) toolResults.push(JSON.parse(message.content));
      }
      response.writeHead(finalStatus, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify(
          finalStatus === 200
            ? {
                id: 'final',
                choices: [
                  {
                    index: 0,
                    finish_reason: 'stop',
                    message: { role: 'assistant', content: 'Привет!' },
                  },
                ],
              }
            : { error: { message: 'provider unavailable' } },
        ),
      );
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const client = new OpenAI({
      apiKey: 'test-key',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      maxRetries: 0,
    });
    let answer: string | undefined;
    try {
      const completion = await sendChatCompletion(
        client,
        'test-model',
        'opencode',
        [{ role: 'user', content: 'Пенёк, привет!' }],
        'low',
        1000,
        { tools: [h.tool] },
      );
      answer = completion.content;
    } catch (error) {
      if (finalStatus !== 500) throw error;
    }
    if (!h.guard.hasAttempted) {
      await h.guard.attempt(async () => {
        h.sent.push({ text: answer ?? 'Ошибка провайдера.', options: h.context.currentMessage });
      });
    }
    return { answer, toolResults };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  }
}

test('the completion loop cannot send twice through repeated calls and its final answer', async () => {
  const h = harness();
  const result = await runToolCompletion(h, 200);
  assert.equal(result.answer, 'Привет!');
  assert.deepEqual(
    result.toolResults.map((item) => item.status),
    ['result', 'not_executed'],
  );
  assert.deepEqual(h.sent, [{ text: 'Привет!', options: { conversationMessageId: 100 } }]);
});

test('a provider failure after successful tool delivery does not send an extra fallback reply', async () => {
  const h = harness();
  const result = await runToolCompletion(h, 500);
  assert.equal(result.answer, undefined);
  assert.deepEqual(
    result.toolResults.map((item) => item.status),
    ['result', 'not_executed'],
  );
  assert.deepEqual(h.sent, [{ text: 'Привет!', options: { conversationMessageId: 100 } }]);
});
