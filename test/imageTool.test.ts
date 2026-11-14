import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GeneratedImage } from '../src/services/image/imageGenerationService.js';
import { createImageTool } from '../src/services/ai/tools/imageTool.js';
import type { PhotoAttachment } from 'vk-io';

const image: GeneratedImage = {
  buffer: Buffer.from([1, 2, 3]),
  contentType: 'image/png',
};

type ToolOptions = {
  isAdmin?: boolean;
  imageAccess?: string;
  photo?: PhotoAttachment;
  dailyCount?: number;
  generateError?: Error;
};

function imageTool(options: ToolOptions = {}) {
  const sent: Array<{ image: GeneratedImage; caption: string }> = [];
  const usage: string[] = [];
  let imageSent = false;
  const tool = createImageTool({
    senderId: '1',
    peerId: 2_000_000_001,
    imageAccess: options.imageAccess ?? 'admins_only',
    checkAccess: async () => ({ allowed: true, isAdmin: options.isAdmin ?? true }),
    getPhoto: async () => options.photo,
    sendPhoto: async (sentImage, caption) => {
      sent.push({ image: sentImage, caption });
    },
    countDailyImages: async () => options.dailyCount ?? 0,
    recordUsage: async (feature) => {
      usage.push(feature);
    },
    onImageSent: () => {
      imageSent = true;
    },
    service: {
      generate: async () => {
        if (options.generateError) throw options.generateError;
        return image;
      },
      edit: async () => image,
    },
  });
  return { tool, sent, usage, wasImageSent: () => imageSent };
}

test('generate_image creates and sends a new image', async () => {
  const { tool, sent, usage, wasImageSent } = imageTool();
  const result = JSON.parse(await tool.execute({ action: 'generate', prompt: 'кот в шлеме' }));
  assert.equal(result.status, 'result');
  assert.equal(result.action, 'generate');
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.image, image);
  assert.match(sent[0]?.caption ?? '', /изображение/iu);
  assert.deepEqual(usage, ['image_generate']);
  assert.equal(wasImageSent(), true);
});

test('generate_image edits a photo from the current message or reply', async () => {
  const photo = {} as PhotoAttachment;
  const { tool, sent, usage } = imageTool({ photo });
  const result = JSON.parse(await tool.execute({ action: 'edit', prompt: 'акварель' }));
  assert.equal(result.status, 'result');
  assert.equal(result.action, 'edit');
  assert.equal(sent.length, 1);
  assert.deepEqual(usage, ['image_edit']);
});

test('generate_image asks for a photo when editing without one', async () => {
  const { tool, sent } = imageTool();
  const result = JSON.parse(await tool.execute({ action: 'edit', prompt: 'акварель' }));
  assert.equal(result.status, 'needs_photo');
  assert.equal(sent.length, 0);
});

test('generate_image respects image access and daily limit', async () => {
  const denied = imageTool({ isAdmin: false, imageAccess: 'admins_only' });
  const deniedResult = JSON.parse(await denied.tool.execute({ action: 'generate', prompt: 'кот' }));
  assert.equal(deniedResult.status, 'not_allowed');
  assert.equal(denied.sent.length, 0);

  const limited = imageTool({ dailyCount: 20 });
  const limitedResult = JSON.parse(
    await limited.tool.execute({ action: 'generate', prompt: 'кот' }),
  );
  assert.equal(limitedResult.status, 'limit_reached');
  assert.equal(limited.sent.length, 0);
});

test('generate_image reports provider errors without sending an image', async () => {
  const { tool, sent, wasImageSent } = imageTool({
    generateError: new Error('moderation_blocked'),
  });
  const result = JSON.parse(await tool.execute({ action: 'generate', prompt: 'кот' }));
  assert.equal(result.status, 'error');
  assert.equal(sent.length, 0);
  assert.equal(wasImageSent(), false);
});
