import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import type { PhotoAttachment } from 'vk-io';
import { ImageGenerationService } from '../src/services/image/imageGenerationService.js';
import { ImageNotExecutedError } from '../src/services/image/imageError.js';

test('image preparation failures prove that Images API was not invoked', async (t) => {
  const service = new ImageGenerationService();
  let calls = 0;
  Reflect.set(service, 'openai', {
    images: {
      generate: async () => {
        calls++;
        throw new Error('Unexpected API call');
      },
      edit: async () => {
        calls++;
        throw new Error('Unexpected API call');
      },
    },
  });
  t.mock.method(service, 'downloadPhoto', async () => {
    throw new Error('Download failed');
  });
  await assert.rejects(service.edit({} as PhotoAttachment, 'test'), ImageNotExecutedError);
  await assert.rejects(
    service.editBuffer(Buffer.from('invalid image'), 'test'),
    ImageNotExecutedError,
  );
  assert.equal(calls, 0);
  Reflect.set(service, 'openai', undefined);
  await assert.rejects(service.generate('test'), ImageNotExecutedError);
  const valid = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'white' } })
    .png()
    .toBuffer();
  await assert.rejects(service.editBuffer(valid, 'test'), ImageNotExecutedError);
  assert.equal(calls, 0);
});

test('errors and invalid responses after Images API remain uncertain', async () => {
  const service = new ImageGenerationService();
  const valid = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'white' } })
    .png()
    .toBuffer();
  for (const error of [
    Object.assign(new Error('Rejected'), { code: 'moderation_blocked', status: 400 }),
    Object.assign(new Error('HTTP failure'), { status: 500 }),
    new Error('Timeout'),
    null,
    '',
  ]) {
    let calls = 0;
    const invoke = async () => {
      calls++;
      if (error instanceof Error) throw error;
      return { data: error === null ? [] : [{ b64_json: error }] };
    };
    Reflect.set(service, 'openai', { images: { generate: invoke, edit: invoke } });
    for (const request of [
      () => service.generate('test'),
      () => service.editBuffer(valid, 'test'),
    ]) {
      await assert.rejects(request, (actual: unknown) => {
        assert.ok(actual instanceof Error);
        assert.ok(!(actual instanceof ImageNotExecutedError));
        if (error instanceof Error) assert.equal(actual, error);
        return true;
      });
    }
    assert.equal(calls, 2);
  }
});

test('successful Images API results preserve output and edit source preparation', async () => {
  const service = new ImageGenerationService();
  const valid = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'white' } })
    .png()
    .toBuffer();
  let calls = 0;
  const invoke = async () => {
    calls++;
    return { data: [{ b64_json: valid.toString('base64') }] };
  };
  Reflect.set(service, 'openai', { images: { generate: invoke, edit: invoke } });
  assert.deepEqual((await service.generate('test')).buffer, valid);
  assert.deepEqual((await service.editBuffer(valid, 'test')).buffer, valid);
  assert.equal(calls, 2);
});
