import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

process.env.VK_TOKEN = 'test-token';
process.env.VK_GROUP_ID = '1';
process.env.VOICE_ENABLED = 'true';
process.env.LOG_LEVEL = 'silent';

const { default: config } = await import('../src/config/index.js');
const { prisma } = await import('../src/db/client.js');
const { default: settingsService } = await import('../src/services/settings/settingsService.js');
const { default: senderService } = await import('../src/services/sender/senderService.js');
const { default: voiceService } = await import('../src/services/voice/voiceService.js');
const { default: subagentResultDeliveryService } =
  await import('../src/services/ai/subagentResultDeliveryService.js');

type SentMessage = {
  peerId: number;
  text: string;
  options: Parameters<typeof senderService.send>[2];
};

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    conversationId: '2000000001',
    userId: '42',
    result: 'Длинный ответ. '.repeat(50),
    messageId: 1,
    conversationMessageId: 1,
    resultSentAt: null,
    status: 'done',
    ...overrides,
  };
}

function mockMethod(
  t: TestContext,
  target: object,
  method: string,
  implementation: (...args: unknown[]) => Promise<unknown>,
) {
  const original = Reflect.get(target, method);
  Reflect.set(target, method, implementation);
  t.after(() => {
    Reflect.set(target, method, original);
  });
}

function mockDelivery(t: TestContext) {
  const sent: SentMessage[] = [];
  const updates: Array<Record<string, unknown>> = [];
  let uploads = 0;
  mockMethod(t, prisma.digestJob, 'findUnique', async () => jobRow());
  mockMethod(t, prisma.digestJob, 'update', async (args) => {
    updates.push((args as { data: Record<string, unknown> }).data);
    return jobRow();
  });
  mockMethod(t, prisma.apiUsage, 'create', async () => ({}));
  t.mock.method(settingsService, 'getUserSettings', async () => ({
    voiceEnabled: true,
    voice: 'coral',
  }));
  t.mock.method(
    senderService,
    'send',
    async (peerId: number, text: string, options: Parameters<typeof senderService.send>[2]) => {
      sent.push({ peerId, text, options });
    },
  );
  t.mock.method(senderService, 'uploadVoice', async () => {
    uploads += 1;
    return `audio_message1_${uploads}`;
  });
  t.mock.method(voiceService, 'synthesize', async () => Buffer.from('audio'));
  return { sent, updates };
}

test('subagent result delivery sends text with voice in a group', async (t) => {
  config.VOICE_ENABLED = true;
  t.after(() => {
    config.VOICE_ENABLED = false;
  });
  const { sent, updates } = mockDelivery(t);
  const delivered = await subagentResultDeliveryService.deliver('job-1');
  assert.equal(delivered, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0]?.text ?? '', /Длинный ответ/u);
  assert.equal(sent[0]?.options?.attachment, 'audio_message1_1');
  assert.equal(sent[0]?.options?.conversationMessageId, 1);
  assert.ok(updates.some((update) => update.resultSentAt instanceof Date));
});

test('subagent result delivery splits private text and attaches voice to each part', async (t) => {
  config.VOICE_ENABLED = true;
  t.after(() => {
    config.VOICE_ENABLED = false;
  });
  const { sent } = mockDelivery(t);
  mockMethod(t, prisma.digestJob, 'findUnique', async () =>
    jobRow({ conversationId: '42', result: 'Длинный ответ. '.repeat(300) }),
  );
  const delivered = await subagentResultDeliveryService.deliver('job-1');
  assert.equal(delivered, true);
  assert.equal(sent.length, 2);
  assert.ok(sent.every((message) => message.text.length > 0));
  assert.ok(sent.every((message) => message.options?.attachment));
  assert.equal(sent[0]?.options?.replyTo, 1);
  assert.equal(sent[1]?.options?.replyTo, undefined);
});

test('subagent result delivery sends text only when voice is disabled', async (t) => {
  config.VOICE_ENABLED = true;
  t.after(() => {
    config.VOICE_ENABLED = false;
  });
  const { sent } = mockDelivery(t);
  t.mock.method(settingsService, 'getUserSettings', async () => ({
    voiceEnabled: false,
    voice: 'coral',
  }));
  const delivered = await subagentResultDeliveryService.deliver('job-1');
  assert.equal(delivered, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.options?.attachment, undefined);
});
