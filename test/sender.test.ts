import assert from 'node:assert/strict';
import test from 'node:test';
import {
  nextRandomId,
  parseAudioMessageUploadFile,
  parsePhotoUploadResponse,
  parseSavedAudioMessage,
} from '../src/services/sender/senderService.js';

test('nextRandomId stays unique across rapid consecutive sends', () => {
  const ids = new Set<number>();
  for (let i = 0; i < 100_000; i++) ids.add(nextRandomId());
  assert.equal(ids.size, 100_000);
  assert.ok([...ids].every((id) => Number.isInteger(id) && id > 0 && id < 2 ** 31));
});

test('VK photo upload response parser accepts complete upload data', () => {
  const expected = {
    server: 909018,
    photo: '[{"photo":"encoded"}]',
    hash: 'upload-hash',
  };
  assert.deepEqual(
    parsePhotoUploadResponse({
      response: { server: '909018', photo: '[{"photo":"encoded"}]', hash: 'upload-hash' },
    }),
    expected,
  );
  assert.deepEqual(parsePhotoUploadResponse(JSON.stringify(expected)), expected);
  assert.deepEqual(parsePhotoUploadResponse({ response: JSON.stringify(expected) }), expected);
});

test('VK photo upload response parser rejects missing or invalid fields', () => {
  assert.equal(parsePhotoUploadResponse({ server: 909018, photo: '', hash: 'hash' }), null);
  assert.equal(parsePhotoUploadResponse({ server: 0, photo: 'photo', hash: 'hash' }), null);
  assert.equal(parsePhotoUploadResponse({ server: 909018, photo: 'photo', hash: '' }), null);
  assert.equal(parsePhotoUploadResponse(null), null);
});

test('VK audio message upload parsers validate the upload token and saved attachment', () => {
  assert.equal(parseAudioMessageUploadFile({ file: 'upload-token' }), 'upload-token');
  assert.equal(parseAudioMessageUploadFile({ file: '' }), null);
  assert.equal(
    parseSavedAudioMessage({
      type: 'audio_message',
      audio_message: { owner_id: -123, id: 456, access_key: 'secret-key' },
    }),
    'audio_message-123_456_secret-key',
  );
  assert.equal(parseSavedAudioMessage({ type: 'doc', doc: { owner_id: 1, id: 2 } }), null);
});
