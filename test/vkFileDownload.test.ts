import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAllowedVkFileUrl } from '../src/services/vk/vkFileDownload.js';

test('VK file URLs allow only trusted VK hosts over HTTPS', () => {
  assert.equal(parseAllowedVkFileUrl('https://vk.com/file.jpg').hostname, 'vk.com');
  assert.equal(
    parseAllowedVkFileUrl('https://sun1-1.userapi.com/file.jpg').hostname,
    'sun1-1.userapi.com',
  );
  assert.equal(
    parseAllowedVkFileUrl('https://sun1-1.vkuserphoto.ru/file.jpg').hostname,
    'sun1-1.vkuserphoto.ru',
  );
});

test('VK file URLs reject insecure, foreign, and crafted hosts', () => {
  for (const url of [
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- проверяем, что http отклоняется
    'http://vk.com/file.jpg',
    'https://evil.example/file.jpg',
    'https://vk.com.evil.example/file.jpg',
    'https://user:pass@vk.com/file.jpg',
    'https://vk.com:8443/file.jpg',
  ]) {
    assert.throws(() => parseAllowedVkFileUrl(url), /unsupported host/iu);
  }
});
