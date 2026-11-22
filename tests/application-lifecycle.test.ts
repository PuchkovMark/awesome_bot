import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { runApplication } from '../src/app/service.js';
import { initializePrompt, requestDisclosureUpdate, resolveApplicationChat } from '../src/app/setup.js';
import { createVkApi, createVkApiCall } from '../src/channels/vk/api.js';
import type { VkPollTransport } from '../src/channels/vk/long-poll.js';
import { createVkRateLimiter } from '../src/channels/vk/rate-limit.js';
import { loadApplicationConfig } from '../src/config/application.js';
import { createLifecycleService } from '../src/core/index.js';
import type { LlmRequest, LlmResult } from '../src/llm/index.js';
import { llmFailure } from '../src/llm/errors.js';
import type { LogEvent, SafeLogger } from '../src/logger/index.js';
import { openStorage } from '../src/storage/index.js';
import { disclosureStore, type DisclosureInput } from '../src/storage/chat-disclosure-store.js';
import { storageFixture } from './helpers/storage-fixture.js';

const ownerId = 'vk:73';
const groupId = 314;
const chatId = 'vk:73';
const testResponse = { kind: 'complete', text: 'Ответ', usage: { input: 1, output: 1 } } as const;

async function fixture() {
  const files = storageFixture();
  const config = loadApplicationConfig({
    env: { VK_TOKEN: 'test-vk', OPENCODE_API_KEY: 'test-opencode', LLM_MODEL: 'test-model', BOT_OWNER_ID: ownerId,
      VK_GROUP_ID: '314', DATABASE_PATH: files.path, MODEL_CONTEXT_TOKENS: '16000', MESSAGE_RETENTION_DAYS: '30',
      LLM_SESSION_SECRET: 'test-session',
    }, readFile: () => '',
  }).config;
  const prompt = join(files.directory, 'prompt.txt');
  await writeFile(prompt, 'Ты отвечаешь на синтетический вопрос.');
  const init = async () => expect(await initializePrompt(config, prompt)).toBeNull();
  return { files, config, init };
}

function transportFixture(hold?: Promise<void>) {
  const ready = Promise.withResolvers<void>();
  let listener: Parameters<VkPollTransport['run']>[0];
  const transport: VkPollTransport = {
    async run(current, signal) {
      listener = current;
      await listener.onGap('startup');
      listener.onReady?.();
      const stopped = Promise.withResolvers<void>();
      if (signal.aborted) stopped.resolve();
      else signal.addEventListener('abort', () => stopped.resolve(), { once: true });
      ready.resolve();
      await stopped.promise;
      await hold;
    },
  };
  return { transport, ready: ready.promise, update(...rows: unknown[]) { listener.onUpdates(rows); } };
}

function loggerFixture() {
  const events: LogEvent[] = [];
  const logger: SafeLogger = {
    event(event) { events.push(event); }, componentError() {}, debugError() {}, debugText() {},
  };
  return { logger, events };
}

function vkFixture(beforeSend?: (peer:number) => Promise<void>, startId = 100, rights?: {
  readonly group: () => boolean;
  readonly owner: () => boolean;
}) {
  const rows = new Map<string, Record<string, unknown>>();
  const eventStart = Math.floor(Date.now() / 1000) - 60;
  let at = 0;
  let counter = startId;
  const attempt = vi.fn<Parameters<typeof createVkApiCall>[0]>(async (method, params) => {
    if (method === 'users.get') return { response: [{ id: 73, first_name: 'Тест' }] };
    if (method === 'messages.getConversationsById') return { response: { items: [{
      peer: { id: Number(params.peer_ids) }, chat_settings:{state:'in'},
      can_write: { allowed: Number(params.peer_ids)>2_000_000_000 ? rights?.group() ?? true : rights?.owner() ?? true },
    }] } };
    if (method === 'messages.isMessagesFromGroupAllowed') return {response:{is_allowed:rights?.owner()===false ? 0 : 1}};
    if (method === 'messages.getConversationMembers') return {response:{items:[{member_id:-groupId,is_admin:false}]}};
    if (method === 'messages.setActivity') return { response: 1 };
    if (method === 'messages.getByConversationMessageId') return { response: {
      items: String(params.conversation_message_ids).split(',').map(id => rows.get(`${params.peer_id}:${id}`)).filter(Boolean),
    } };
    if (method === 'messages.send') {
      const peer = Number(params.peer_ids);
      await beforeSend?.(peer);
      const id = ++counter;
      const forward = params.forward === undefined ? null : JSON.parse(String(params.forward)) as { conversation_message_ids: number[] };
      rows.set(`${peer}:${id}`, {
        peer_id: peer, from_id: -groupId, conversation_message_id: id, text: params.message,
        date: Math.floor(Date.now() / 1000), ...(forward ? { reply_message: rows.get(`${peer}:${forward.conversation_message_ids[0]}`) } : {}),
      });
      return { response: [{ peer_id: peer, conversation_message_id: id }] };
    }
    throw new Error('Unexpected virtual VK request');
  });
  const api = createVkApi(groupId, createVkApiCall(attempt, createVkRateLimiter({
    now: () => at, async wait(ms) { at += ms; },
  })));
  return {
    api, attempt,
    event(id: number, peer = 73, action?: object, text = '[club314|Пенек] Вопрос') {
      const message = { peer_id: peer, from_id: 73, conversation_message_id: id,
        text, date: eventStart + id, out: 0, ...(action ? { action } : {}),
      };
      rows.set(`${peer}:${id}`, message);
      return { type: 'message_new', group_id: groupId, object: { message } };
    },
  };
}

async function inspect(path: string) {
  const storage = await openStorage(path);
  return {
    storage,
    life: createLifecycleService({ storage, ownerId, source: { async observe() {
      return { confidence: 'unavailable', bot: 'unknown' };
    } } }),
  };
}

const testDisclosure = {provider:'OpenCode Go',dataPolicy:'history',storagePolicy:'initial',detailsText:'Синтетические условия.',
  detailsUrl:'https://example.test/disclosure/1',ownerContact:'Тестовый владелец',change:'material'} satisfies DisclosureInput;
const testPeer = 2_000_000_010;
const testGroup = 'vk:2000000010';

test('граница публикации закрывает ранний вход, а восстановление права отменяет предупреждение владельцу', async () => {
  const f=await fixture();
  const inspector=await inspect(f.files.path);
  const store=disclosureStore(inspector.storage);
  const transport=transportFixture();
  const {logger}=loggerFixture();
  const stop=new AbortController();
  const entered=Promise.withResolvers<void>();
  const publish=Promise.withResolvers<void>();
  let groupAllowed=false, ownerAllowed=false;
  const vk=vkFixture(async peer => {
    if(peer===testPeer){entered.resolve();await publish.promise;}
  },100,{group:()=>groupAllowed,owner:()=>ownerAllowed});
  const model=vi.fn(async()=>testResponse);
  await f.init();
  const version=store.register(testDisclosure,Date.now());
  const run=runApplication(f.config,logger,stop.signal,{vk:{api:vk.api,transport:transport.transport},client:{complete:model},onboardingIntervalMs:5});
  try {
    await transport.ready;
    transport.update(vk.event(51,testPeer,{type:'chat_invite_user',member_id:-groupId}));
    await resolveApplicationChat({databasePath:f.files.path,ownerId},testGroup,'continue');
    const scope=inspector.life.current(testGroup);
    await vi.waitFor(()=>expect(store.publications(scope).find(row=>row.kind==='owner')?.reason).toBe('owner_closed'));
    groupAllowed=true;ownerAllowed=true;
    await entered.promise;
    transport.update(vk.event(52,testPeer));
    expect(await inspector.storage.messages.list(scope,{limit:20})).toEqual([]);
    expect(model).not.toHaveBeenCalled();
    publish.resolve();
    await vi.waitFor(()=>expect(store.gate(scope).version).toBe(version));
    expect(store.publications(scope).find(row=>row.kind==='owner')?.state).toBe('cancelled');
    expect(store.diagnostics()).toEqual([{kind:'introduction',state:'delivered',connections:1},{kind:'owner',state:'cancelled',connections:1}]);
    transport.update(vk.event(53,testPeer),vk.event(54,testPeer,undefined,'/часовой-пояс GMT'));
    await vi.waitFor(async()=>{
      const entries=await inspector.storage.messages.list(scope,{limit:20});
      expect(entries.find(row=>row.replyToMessageId==='53')).toMatchObject({text:'Ответ'});
      expect(entries.some(row=>row.messageId==='52')).toBe(false);
      expect((await inspector.storage.chats.get(scope))?.timezone).toBe('UTC');
    });
    expect(model).toHaveBeenCalledTimes(1);
    expect((await inspector.storage.traces.last(scope))?.payload.disclosure).toEqual({version,allowed:true});
    expect(vk.attempt.mock.calls.filter(([method])=>method==='messages.send').map(([,args])=>Number(args.peer_ids))).toEqual([testPeer,testPeer]);
  } finally { publish.resolve();stop.abort();expect(await run).toBeNull();await inspector.storage.close();f.files.cleanup(); }
});

test('смена версии перед повтором закрывает вызов и оставляет журнал при прежних условиях хранения', async () => {
  const f=await fixture();
  const inspector=await inspect(f.files.path);
  const store=disclosureStore(inspector.storage);
  const transport=transportFixture();
  const vk=vkFixture();
  const {logger}=loggerFixture();
  const stop=new AbortController();
  await f.init();
  const version=store.register(testDisclosure,Date.now());
  const model=vi.fn(async():Promise<LlmResult>=>{
    if(model.mock.calls.length===1){
      store.register({...testDisclosure,dataPolicy:'new data'},Date.now());
      return llmFailure('server');
    }
    return testResponse;
  });
  const run=runApplication(f.config,logger,stop.signal,{vk:{api:vk.api,transport:transport.transport},client:{complete:model},onboardingIntervalMs:5});
  try {
    await transport.ready;
    transport.update(vk.event(60,testPeer,{type:'chat_invite_user',member_id:-groupId}));
    await resolveApplicationChat({databasePath:f.files.path,ownerId},testGroup,'continue');
    const scope=inspector.life.current(testGroup);
    await vi.waitFor(()=>expect(store.gate(scope).version).toBe(version));
    store.register({...testDisclosure,change:'editorial',detailsUrl:'https://example.test/disclosure/editorial'},Date.now());
    transport.update(vk.event(61,testPeer));
    await vi.waitFor(async()=>expect((await inspector.storage.traces.last(scope))?.outcome).toBe('interrupted'),{timeout:3500});
    expect(model).toHaveBeenCalledTimes(1);
    expect((await inspector.storage.traces.last(scope))?.payload.disclosure).toEqual({version,allowed:false});
    transport.update(vk.event(62,testPeer));
    await vi.waitFor(async()=>expect((await inspector.storage.messages.list(scope,{limit:20})).some(row=>row.messageId==='62')).toBe(true));
    expect(model).toHaveBeenCalledTimes(1);
    const replacement=store.register({...testDisclosure,dataPolicy:'new data',storagePolicy:'changed'},Date.now());
    transport.update(vk.event(63,testPeer));
    expect(await requestDisclosureUpdate({databasePath:f.files.path,ownerId},testGroup)).toBe(true);
    await vi.waitFor(()=>expect(store.gate(scope).version).toBe(replacement));
    transport.update(vk.event(64,testPeer));
    await vi.waitFor(async()=>{
      const rows=await inspector.storage.messages.list(scope,{limit:20});
      expect(rows.some(row=>row.messageId==='63')).toBe(false);
      expect(rows.find(row=>row.replyToMessageId==='64')).toMatchObject({text:'Ответ'});
    });
    expect(model).toHaveBeenCalledTimes(2);
    expect((await inspector.storage.traces.last(scope))?.payload.disclosure).toEqual({version:replacement,allowed:true});
  } finally { stop.abort();expect(await run).toBeNull();await inspector.storage.close();f.files.cleanup(); }
});

test('штатная композиция ждёт допуска, публикует через VK и сохраняет сессию после перезапуска', async () => {
  const f = await fixture();
  try {
    await f.init();
    const { logger, events } = loggerFixture();
    const inspector = await inspect(f.files.path);
    try {
      const sessions: string[] = [];
      for (const round of [1, 2, 3, 4]) {
        const transport = transportFixture();
        const vk = vkFixture(undefined, round * 100);
        const stop = new AbortController();
        const run = runApplication(round >= 3 ? { ...f.config, sessionSecret: 'rotated-secret' } : f.config, logger, stop.signal, {
          vk: { api: vk.api, transport: transport.transport },
          client: { async complete(request) {
            const scope = inspector.life.current(chatId);
            const history = await inspector.storage.messages.list(scope, { limit: 20 });
            expect(history.find(row => row.messageId === String(round))).toBeDefined();
            sessions.push(request.sessionId);
            return testResponse;
          } },
        });
        try {
          await transport.ready;
          transport.update(vk.event(50, 2_000_000_010, { type: 'chat_invite_user', member_id: -groupId }), vk.event(99));
          await vi.waitFor(() => expect(() => inspector.life.current(chatId)).toThrow('uncertain_connection'));
          await resolveApplicationChat({ databasePath: f.files.path, ownerId }, chatId, round === 4 ? 'new' : 'continue');
          transport.update(vk.event(round));
          await vi.waitFor(async () => {
            const history = await inspector.storage.messages.list(inspector.life.current(chatId), { limit: 20 });
            expect(history.filter(row => row.role === 'assistant')).toHaveLength(round === 4 ? 1 : round);
            expect(history.find(row => row.replyToMessageId === String(round))).toMatchObject({ text: 'Ответ' });
          });
          expect(() => inspector.life.current('vk:2000000010')).toThrow('uncertain_connection');
        } finally {
          stop.abort();
          expect(await run).toBeNull();
        }
      }
      expect(sessions).toHaveLength(4);
      expect(sessions[0]).toBe(sessions[1]);
      expect(sessions[2]).not.toBe(sessions[1]);
      expect(sessions[3]).not.toBe(sessions[2]);
      expect(events.filter(e => e.event === 'application_ready')).toHaveLength(4);
    } finally { await inspector.storage.close(); }
  } finally { f.files.cleanup(); }
});

test('остановка отменяет активный запрос модели и сохраняет interrupted при повторном открытии БД', async () => {
  const f = await fixture();
  const transport = transportFixture();
  const vk = vkFixture();
  const stop = new AbortController();
  const entered = Promise.withResolvers<LlmRequest>();
  const pending = Promise.withResolvers<LlmResult>();
  await f.init();
  const run = runApplication(f.config, loggerFixture().logger, stop.signal, {
    vk: { api: vk.api, transport: transport.transport }, client: {
      complete(request) { entered.resolve(request); return pending.promise; },
    },
  });
  try {
    await transport.ready;
    await resolveApplicationChat({ databasePath: f.files.path, ownerId }, chatId, 'new');
    transport.update(vk.event(1));
    const request = await entered.promise;
    stop.abort();
    stop.abort();
    expect(request.signal?.aborted).toBe(true);
    expect(await run).toBeNull();
    pending.resolve(testResponse);
    const { life, storage } = await inspect(f.files.path);
    try {
      const scope = life.current(chatId);
      expect(await storage.queue.get(scope, 1)).toMatchObject({ outcome: 'interrupted' });
      expect(await storage.messages.list(scope, { limit: 10 })).toHaveLength(1);
      expect(vk.attempt.mock.calls.filter(([method]) => method === 'messages.send')).toHaveLength(0);
    } finally { await storage.close(); }
  } finally { pending.resolve(testResponse); stop.abort(); await run; f.files.cleanup(); }
});

test('поздняя квитанция отправки не обращается к закрытой БД', async () => {
  const f = await fixture();
  const transport = transportFixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const vk = vkFixture(() => { entered.resolve(); return release.promise; });
  const stop = new AbortController();
  await f.init();
  const run = runApplication(f.config, loggerFixture().logger, stop.signal, {
    vk: { api: vk.api, transport: transport.transport }, client: { async complete() { return testResponse; } },
  });
  try {
    await transport.ready;
    await resolveApplicationChat({ databasePath: f.files.path, ownerId }, chatId, 'new');
    transport.update(vk.event(1));
    await entered.promise;
    stop.abort();
    expect(await run).toBeNull();
    release.resolve();
    const { life, storage } = await inspect(f.files.path);
    try {
      expect(await storage.messages.list(life.current(chatId), { limit: 10 })).toHaveLength(1);
      expect(vk.attempt.mock.calls.filter(([method]) => method === 'messages.send')).toHaveLength(1);
    } finally { await storage.close(); }
  } finally { release.resolve(); stop.abort(); await run; f.files.cleanup(); }
});

test('закрывает частичный старт и ограничивает остановку неподчиняющегося транспорта', async () => {
  const f = await fixture();
  const { logger, events } = loggerFixture();
  const stop = new AbortController();
  const release = Promise.withResolvers<void>();
  try {
    expect(await runApplication(f.config, logger, stop.signal)).toBe('missing_system_prompt');
    await f.init();
    expect(await runApplication(f.config, logger, stop.signal, { vk: { transport: {
      async run() { throw new Error('synthetic-secret-in-error'); },
    } } })).toBe('vk_failed');
    expect(events.some(event => event.event === 'application_ready')).toBe(false);
    expect(await runApplication(f.config, logger, stop.signal, {
      readyTimeoutMs: 25, vk: { transport: { async run(_listener, signal) {
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      } } },
    })).toBe('ready_timeout');

    const transport = transportFixture(release.promise);
    const run = runApplication(f.config, logger, stop.signal, { vk: { transport: transport.transport }, stopTimeoutMs: 35 });
    await transport.ready;
    stop.abort();
    expect(await run).toBe('stop_timeout');
  } finally { release.resolve(); await new Promise(resolve => setImmediate(resolve)); f.files.cleanup(); }
});
