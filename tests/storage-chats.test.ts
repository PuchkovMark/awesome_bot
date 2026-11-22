import { openStorage, scopeFor } from './helpers/connection-scope.js';
import { afterEach, expect, test } from 'vitest';
import { type ChatInput, type ChatPatch, type Storage } from '../src/storage/index.js';

const opened: Storage[] = [];
const chatStores=new WeakMap<object,Storage>();
function chatScope(chats:object,chatId:unknown){return scopeFor(chatStores.get(chats)!,chatId);}
afterEach(async () => { for (const storage of opened.splice(0)) await storage.close(); });
async function setup() { const storage = await openStorage(':memory:'); opened.push(storage); chatStores.set(storage.chats,storage); return storage.chats; }
const initial: ChatInput = { responseMode: 'normal', enabled: false, createdAt: 0 };
test('явная начальная политика, default таймзоны и nullable полей', async () => {
  const chats = await setup();
  expect(await chats.get(chatScope(chats,'vk:1'))).toBeNull();
  expect(await chats.update(chatScope(chats,'vk:1'), { enabled: true })).toBeNull();
  expect(await chats.create(chatScope(chats,'vk:1'), initial)).toEqual({ status: 'created', settings: {
    chatId: 'vk:1', ...initial, title: null, timezone: 'Europe/Moscow',
  } });
  expect(await chats.create(chatScope(chats,'vk:2'), { ...initial, responseMode: 'active', enabled: true, timezone: 'UTC', title: 'Имя' }))
    .toMatchObject({ settings: { responseMode: 'active', enabled: true, timezone: 'UTC', title: 'Имя' } });
});
test('patch изолирован, не меняет дату, null сбрасывает название, повторное создание сохраняет изменения', async () => {
  const chats = await setup();
  await chats.create(chatScope(chats,'vk:1'), initial); await chats.create(chatScope(chats,'vk:2'), initial);
  await chats.update(chatScope(chats,'vk:1'), { title: 'Новый', enabled: true, responseMode: 'active', timezone: 'UTC' });
  const expected = await chats.update(chatScope(chats,'vk:1'), { title: null });
  expect(expected).toMatchObject({ title: null, createdAt: 0, enabled: true });
  expect(await chats.create(chatScope(chats,'vk:1'), { ...initial, createdAt: 100 })).toEqual({ status: 'existing', settings: expected });
  expect(await chats.get(chatScope(chats,'vk:2'))).toMatchObject({ title: null, enabled: false, responseMode: 'normal' });
});
for (const input of [
  {}, { ...initial, enabled: 1 }, { ...initial, responseMode: 'other' },
  { ...initial, createdAt: -1 }, { ...initial, timezone: 'Bad/Zone' }, { ...initial, title: 42 },
]) {
  test(`некорректное создание ${JSON.stringify(input)}, в том числе существующего чата`, async () => {
    const chats = await setup(); await chats.create(chatScope(chats,'vk:1'), initial);
    await expect(chats.create(chatScope(chats,'vk:1'), input as ChatInput)).rejects.toMatchObject({ code: 'invalid_input' });
  });
}
for (const patch of [{}, { chatId: 'vk:2' }, { createdAt: 1 }, { arbitrary: 1 }, { enabled: 1 }, { timezone: '' }, { title: undefined }, { systemPrompt: undefined }]) {
  test(`некорректный patch ${JSON.stringify(patch)}`, async () => {
    const chats = await setup(); await chats.create(chatScope(chats,'vk:1'), initial);
    await expect(chats.update(chatScope(chats,'vk:1'), patch as ChatPatch)).rejects.toMatchObject({ code: 'invalid_input' });
  });
}
for(const value of [null,undefined,'legacy'])test(`устаревший systemPrompt отклоняется до любых записей: ${String(value)}`,async()=>{
 const chats=await setup(),scope=chatScope(chats,'vk:old');
 await expect(chats.create(scope,{...initial,systemPrompt:value} as ChatInput)).rejects.toMatchObject({code:'invalid_input'});
 expect(await chats.get(scope)).toBeNull();
 await chats.create(scope,initial);const before=await chats.get(scope);expect(before).not.toHaveProperty('systemPrompt');
 await expect(chats.create(scope,{...initial,systemPrompt:value} as ChatInput)).rejects.toMatchObject({code:'invalid_input'});
 await expect(chats.update(scope,{title:'Не применять',enabled:true,systemPrompt:value} as ChatPatch)).rejects.toMatchObject({code:'invalid_input'});
 expect(await chats.get(scope)).toEqual(before);
});
