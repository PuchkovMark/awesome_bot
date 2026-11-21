import { afterEach, expect, test } from 'vitest';
import { openStorage, type ChatInput, type ChatPatch, type Storage } from '../src/storage/index.js';

const opened: Storage[] = [];
afterEach(async () => { for (const storage of opened.splice(0)) await storage.close(); });
async function setup() { const storage = await openStorage(':memory:'); opened.push(storage); return storage.chats; }
const initial: ChatInput = { responseMode: 'mention', enabled: false, createdAt: 0 };
test('явная начальная политика, default таймзоны и nullable полей', async () => {
  const chats = await setup();
  expect(await chats.get('vk:1')).toBeNull();
  expect(await chats.update('vk:1', { enabled: true })).toBeNull();
  expect(await chats.create('vk:1', initial)).toEqual({ status: 'created', settings: {
    chatId: 'vk:1', ...initial, title: null, systemPrompt: null, timezone: 'Europe/Moscow',
  } });
  expect(await chats.create('vk:2', { ...initial, responseMode: 'always', enabled: true, timezone: 'UTC', title: 'Имя', systemPrompt: 'Текст' }))
    .toMatchObject({ settings: { responseMode: 'always', enabled: true, timezone: 'UTC', title: 'Имя', systemPrompt: 'Текст' } });
});
test('patch изолирован, не меняет дату, null сбрасывает промпт, повторное создание сохраняет изменения', async () => {
  const chats = await setup();
  await chats.create('vk:1', initial); await chats.create('vk:2', initial);
  await chats.update('vk:1', { title: 'Новый', systemPrompt: 'Текст', enabled: true, responseMode: 'always', timezone: 'UTC' });
  const expected = await chats.update('vk:1', { systemPrompt: null });
  expect(expected).toMatchObject({ title: 'Новый', systemPrompt: null, createdAt: 0, enabled: true });
  expect(await chats.create('vk:1', { ...initial, createdAt: 100 })).toEqual({ status: 'existing', settings: expected });
  expect(await chats.get('vk:2')).toMatchObject({ title: null, enabled: false, responseMode: 'mention' });
});
for (const input of [
  {}, { ...initial, enabled: 1 }, { ...initial, responseMode: 'other' },
  { ...initial, createdAt: -1 }, { ...initial, timezone: 'Bad/Zone' }, { ...initial, title: 42 },
]) {
  test(`некорректное создание ${JSON.stringify(input)}, в том числе существующего чата`, async () => {
    const chats = await setup(); await chats.create('vk:1', initial);
    await expect(chats.create('vk:1', input as ChatInput)).rejects.toMatchObject({ code: 'invalid_input' });
  });
}
for (const patch of [{}, { chatId: 'vk:2' }, { createdAt: 1 }, { arbitrary: 1 }, { enabled: 1 }, { timezone: '' }, { title: undefined }, { systemPrompt: undefined }]) {
  test(`некорректный patch ${JSON.stringify(patch)}`, async () => {
    const chats = await setup(); await chats.create('vk:1', initial);
    await expect(chats.update('vk:1', patch as ChatPatch)).rejects.toMatchObject({ code: 'invalid_input' });
  });
}
