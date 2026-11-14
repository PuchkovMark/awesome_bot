import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

process.env.VK_TOKEN = 'test-token';
process.env.VK_GROUP_ID = '1';
process.env.LOG_LEVEL = 'silent';

const { default: senderService } = await import('../src/services/sender/senderService.js');
const { default: voiceService } = await import('../src/services/voice/voiceService.js');
const { sendVoiceAwareResponse, VOICE_FAILURE_NOTICE } =
  await import('../src/services/voice/voiceResponseService.js');

const groupPeer = 2_000_000_001;
const privatePeer = 42;

type SentMessage = {
  peerId: number;
  text: string;
  options: Parameters<typeof senderService.send>[2];
};

function mockSender(t: TestContext) {
  const sent: SentMessage[] = [];
  let uploads = 0;
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
  return { sent, uploads: () => uploads };
}

test('text-only response does not synthesize voice', async (t) => {
  const { sent } = mockSender(t);
  const result = await sendVoiceAwareResponse({
    peerId: groupPeer,
    text: 'Короткий ответ',
  });
  assert.equal(result.voiceSent, false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.text, 'Короткий ответ');
  assert.equal(sent[0]?.options?.attachment, undefined);
});

test('group response attaches one voice message to the text message', async (t) => {
  const { sent } = mockSender(t);
  let synthesized = '';
  t.mock.method(voiceService, 'synthesize', async (text: string) => {
    synthesized = text;
    return Buffer.from('audio');
  });
  const text = 'Длинный ответ. '.repeat(50);
  const result = await sendVoiceAwareResponse({
    peerId: groupPeer,
    text,
    voice: 'coral',
    options: { conversationMessageId: 10 },
  });
  assert.equal(result.voiceSent, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.text, text);
  assert.equal(sent[0]?.options?.attachment, 'audio_message1_1');
  assert.equal(sent[0]?.options?.conversationMessageId, 10);
  assert.equal(synthesized, text);
  assert.doesNotMatch(sent[0]?.text ?? '', /Голосовой ответ сгенерирован/iu);
});

test('group response longer than the VK limit stays one message and voices the sent text', async (t) => {
  const { sent } = mockSender(t);
  let synthesized = '';
  t.mock.method(voiceService, 'synthesize', async (text: string) => {
    synthesized = text;
    return Buffer.from('audio');
  });
  const text = 'Очень длинный ответ. '.repeat(300);
  const result = await sendVoiceAwareResponse({
    peerId: groupPeer,
    text,
    voice: 'coral',
  });
  assert.equal(result.voiceSent, true);
  assert.equal(sent.length, 1);
  assert.ok((sent[0]?.text.length ?? 0) <= 4000);
  assert.ok((sent[0]?.text.length ?? 0) > 3900);
  assert.match(sent[0]?.text ?? '', /Ответ сокращён/iu);
  assert.equal(sent[0]?.options?.attachment, 'audio_message1_1');
  assert.ok(synthesized.length <= 4000);
  assert.ok(synthesized.length > 3900);
  assert.doesNotMatch(synthesized, /Ответ сокращён/iu);
});

test('private long response sends each text part with its own voice', async (t) => {
  const { sent } = mockSender(t);
  const synthesized: string[] = [];
  t.mock.method(voiceService, 'synthesize', async (text: string) => {
    synthesized.push(text);
    return Buffer.from('audio');
  });
  const text = 'Длинный ответ. '.repeat(300);
  const result = await sendVoiceAwareResponse({
    peerId: privatePeer,
    text,
    voice: 'coral',
    options: { replyTo: 11 },
    keyboard: 'keyboard',
  });
  assert.equal(result.voiceSent, true);
  assert.equal(sent.length, 2);
  assert.equal(synthesized.length, 2);
  assert.equal(sent[0]?.text, synthesized[0]);
  assert.equal(sent[1]?.text, synthesized[1]);
  assert.ok(sent.every((message) => message.text.length > 0));
  assert.ok(sent.every((message) => message.options?.attachment));
  assert.equal(sent[0]?.options?.replyTo, 11);
  assert.equal(sent[1]?.options?.replyTo, undefined);
  assert.equal(sent[0]?.options?.keyboard, 'keyboard');
  assert.equal(sent[1]?.options?.keyboard, undefined);
});

test('voice failure sends text with a failure notice and no attachment', async (t) => {
  const { sent } = mockSender(t);
  t.mock.method(voiceService, 'synthesize', async () => {
    throw new Error('TTS failed');
  });
  const text = 'Длинный ответ. '.repeat(50);
  const result = await sendVoiceAwareResponse({
    peerId: groupPeer,
    text,
    voice: 'coral',
  });
  assert.equal(result.voiceSent, false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.options?.attachment, undefined);
  assert.match(sent[0]?.text ?? '', /Не удалось озвучить ответ/iu);
  assert.ok((sent[0]?.text ?? '').includes(VOICE_FAILURE_NOTICE.trim()));
});

test('private voice failure still sends the text part', async (t) => {
  const { sent } = mockSender(t);
  t.mock.method(voiceService, 'synthesize', async () => {
    throw new Error('TTS failed');
  });
  const text = 'Длинный ответ. '.repeat(50);
  const result = await sendVoiceAwareResponse({
    peerId: privatePeer,
    text,
    voice: 'coral',
  });
  assert.equal(result.voiceSent, false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.options?.attachment, undefined);
  assert.match(sent[0]?.text ?? '', /Не удалось озвучить ответ/iu);
  assert.ok((sent[0]?.text ?? '').startsWith(text));
});
