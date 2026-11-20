import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GeneratedImage } from '../src/services/image/imageGenerationService.js';
import { createImageTool } from '../src/services/ai/tools/imageTool.js';
import type { PhotoAttachment } from 'vk-io';
import config from '../src/config/index.js';
import { ImageNotExecutedError } from '../src/services/image/imageError.js';
import type { ImageQuotaOutcome } from '../src/services/image/imageQuotaService.js';

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
  quotaError?: boolean;
  finishError?: boolean;
  usageError?: boolean;
  deliveryError?: boolean;
  accessDenied?: boolean;
  alreadyProcessed?: boolean;
};

function imageTool(options: ToolOptions = {}) {
  const sent: Array<{ image: GeneratedImage; caption: string }> = [];
  const usage: string[] = [];
  let imageSent = false;
  let generations = 0;
  let reservations = 0;
  const outcomes: ImageQuotaOutcome[] = [];
  const reservedAt = new Date('2026-11-19T23:59:59Z');
  const usageDates: Date[] = [];
  const tool = createImageTool({
    senderId: '1',
    peerId: 2_000_000_001,
    imageAccess: options.imageAccess ?? 'admins_only',
    checkAccess: async () =>
      options.accessDenied
        ? { allowed: false, message: 'Нет доступа.' }
        : { allowed: true, isAdmin: options.isAdmin ?? true },
    getPhoto: async () => options.photo,
    sendPhoto: async (sentImage, caption) => {
      sent.push({ image: sentImage, caption });
      if (options.deliveryError) throw new Error('Lost VK ACK');
    },
    quota: {
      reserve: async ({ operationId }) => {
        reservations++;
        if (options.quotaError) throw new Error('Database unavailable');
        if (options.alreadyProcessed) return { status: 'already_processed' };
        if ((options.dailyCount ?? 0) >= config.IMAGE_MAX_PER_USER_PER_DAY) {
          return { status: 'limit_reached' };
        }
        return { status: 'reserved', operationId, utcDay: '2026-11-19', reservedAt };
      },
      finish: async (_operationId, outcome) => {
        outcomes.push(outcome);
        if (options.finishError) throw new Error('Finish failed');
      },
    },
    recordUsage: async (feature, date) => {
      usageDates.push(date);
      if (options.usageError) throw new Error('Usage failed');
      usage.push(feature);
    },
    onImageSent: () => {
      imageSent = true;
    },
    service: {
      generate: async () => {
        generations++;
        if (options.generateError) throw options.generateError;
        return image;
      },
      edit: async () => {
        generations++;
        if (options.generateError) throw options.generateError;
        return image;
      },
    },
  });
  return {
    tool,
    sent,
    usage,
    outcomes,
    usageDates,
    wasImageSent: () => imageSent,
    generations: () => generations,
    reservations: () => reservations,
  };
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
  assert.equal(limited.generations(), 0);
});

test('image tool validates and checks access/photo before reserving quota', async () => {
  for (const [options, input, status] of [
    [{}, { action: 'unknown', prompt: 'кот' }, 'not_executed'],
    [{ accessDenied: true }, { action: 'generate', prompt: 'кот' }, 'not_executed'],
    [{ isAdmin: false }, { action: 'generate', prompt: 'кот' }, 'not_allowed'],
    [{ dailyCount: 20 }, { action: 'edit', prompt: 'кот' }, 'needs_photo'],
  ] as const) {
    const fixture = imageTool(options);
    assert.equal(JSON.parse(await fixture.tool.execute(input)).status, status);
    assert.equal(fixture.reservations(), 0);
    assert.equal(fixture.generations(), 0);
  }
});

test('image tool refuses database failures and operation replay before generation', async () => {
  for (const options of [{ quotaError: true }, { alreadyProcessed: true }]) {
    const fixture = imageTool(options);
    const result = JSON.parse(await fixture.tool.execute({ action: 'generate', prompt: 'кот' }));
    assert.equal(result.status, options.quotaError ? 'error' : 'not_executed');
    assert.equal(fixture.generations(), 0);
    assert.equal(fixture.sent.length, 0);
  }
});

test('image tool releases only proven preparation failures', async () => {
  for (const generateError of [
    new ImageNotExecutedError(new Error('Sharp failed')),
    Object.assign(new Error('Moderation'), { code: 'moderation_blocked' }),
    new Error('Timeout'),
    new Error('Empty response'),
  ]) {
    const fixture = imageTool({ generateError });
    assert.equal(
      JSON.parse(await fixture.tool.execute({ action: 'generate', prompt: 'кот' })).status,
      'error',
    );
    assert.deepEqual(fixture.outcomes, [
      generateError instanceof ImageNotExecutedError ? 'released' : 'uncertain',
    ]);
    assert.equal(fixture.sent.length, 0);
    assert.equal(fixture.generations(), 1);
  }
});

test('image tool preserves result and reservation timestamp when usage or finish fails', async () => {
  for (const options of [{ usageError: true }, { finishError: true }]) {
    const fixture = imageTool(options);
    assert.equal(
      JSON.parse(await fixture.tool.execute({ action: 'generate', prompt: 'кот' })).status,
      'result',
    );
    assert.equal(fixture.wasImageSent(), true);
    assert.deepEqual(fixture.outcomes, ['consumed']);
    assert.equal(fixture.usageDates[0]?.toISOString(), '2026-11-19T23:59:59.000Z');
    assert.equal(fixture.generations(), 1);
    assert.equal(fixture.sent.length, 1);
  }
});

test('image tool never releases quota after generation when VK loses ACK', async () => {
  const fixture = imageTool({ deliveryError: true });
  assert.equal(
    JSON.parse(await fixture.tool.execute({ action: 'generate', prompt: 'кот' })).status,
    'error',
  );
  assert.deepEqual(fixture.outcomes, ['consumed']);
  assert.equal(fixture.generations(), 1);
  assert.equal(fixture.usage.length, 0);
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
