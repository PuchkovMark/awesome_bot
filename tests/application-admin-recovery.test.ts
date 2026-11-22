import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { expect, test, vi } from 'vitest';
import { runCli } from '../src/app/cli.js';
import { runApplication } from '../src/app/service.js';
import { initializePrompt, resolveApplicationChat } from '../src/app/setup.js';
import { createVkApi, createVkApiCall } from '../src/channels/vk/api.js';
import type { VkPollTransport } from '../src/channels/vk/long-poll.js';
import { createVkRateLimiter } from '../src/channels/vk/rate-limit.js';
import { loadApplicationConfig } from '../src/config/application.js';
import { createLifecycleService } from '../src/core/index.js';
import type { SafeLogger } from '../src/logger/index.js';
import { adminRecoveryStore } from '../src/storage/admin-recovery-store.js';
import { openStorage } from '../src/storage/index.js';
import { storageFixture } from './helpers/storage-fixture.js';

const groupId=314, peer=2000000030, owner=73, candidate=31;
const chatId=`vk:${peer}` as const, ownerId=`vk:${owner}` as const, userId=`vk:${candidate}` as const;
const logger: SafeLogger={event(){},componentError(){},debugError(){},debugText(){}};

async function fixture() {
  const files=storageFixture();
  const config=loadApplicationConfig({env:{
    VK_TOKEN:'test-vk',VK_GROUP_ID:String(groupId),BOT_OWNER_ID:ownerId,DATABASE_PATH:files.path,
    OPENCODE_API_KEY:'test-go',LLM_MODEL:'test-model',MODEL_CONTEXT_TOKENS:'16000',
    MESSAGE_RETENTION_DAYS:'30',LLM_SESSION_SECRET:'test-session',
  },readFile:()=>''}).config;
  const prompt=join(files.directory,'prompt.txt');
  await writeFile(prompt,'Синтетическое сообщение.');
  expect(await initializePrompt(config,prompt)).toBeNull();
  const storage=await openStorage(files.path);
  const life=createLifecycleService({storage,ownerId,source:{async observe(){return {confidence:'unavailable',bot:'unknown'};}}});
  const store=adminRecoveryStore(storage);
  const model=vi.fn(async()=>({kind:'empty' as const,usage:{input:0,output:0}}));
  const messages=new Map<string,Record<string,unknown>>();
  const virtual={allowed:true,lookup:true,creator:0,inviter:0,joinDate:0};
  let clock=0, next=900;
  const attempt=vi.fn<Parameters<typeof createVkApiCall>[0]>(async (method,args)=>{
    if (method==='messages.getConversationsById') return {response:{items:[{peer:{id:Number(args.peer_ids)},can_write:{allowed:true},
      chat_settings:{state:'in',owner_id:virtual.creator}}]}};
    if (method==='messages.getConversationMembers') return {response:{items:[
      {member_id:-groupId,is_admin:true,invited_by:virtual.inviter,join_date:virtual.joinDate},
      ...[...new Set([candidate,virtual.creator,virtual.inviter])].filter(Boolean)
        .map(id=>({member_id:id,is_owner:id===virtual.creator}))]}};
    if (method==='messages.isMessagesFromGroupAllowed') return {response:{is_allowed:Number(virtual.allowed)}};
    if (method==='messages.getByConversationMessageId') return {response:{items:virtual.lookup
      ? String(args.conversation_message_ids).split(',').map(id=>messages.get(`${args.peer_id}:${id}`)).filter(Boolean) : []}};
    if (method==='messages.send') {
      const id=++next, destination=Number(args.peer_ids);
      const row={from_id:-groupId,peer_id:destination,conversation_message_id:id,text:args.message,date:Math.floor(Date.now()/1000)};
      messages.set(`${destination}:${id}`,row);
      return {response:[row]};
    }
    throw new Error('Незапланированный запрос VK');
  });
  const api=createVkApi(groupId,createVkApiCall(attempt,createVkRateLimiter({now:()=>clock,wait:async ms=>{clock+=ms;}})));
  const appConfig={databasePath:files.path,ownerId};
  return {
    storage,life,store,virtual,model,
    async localStatus() {
      let text='';
      const destination=new PassThrough();
      destination.on('data',chunk=>{text+=String(chunk);});
      expect(await runCli(['admin-recovery-status',chatId],{destination,
        config:{env:{BOT_OWNER_ID:ownerId,DATABASE_PATH:files.path},readFile:()=>''}})).toBe(0);
      return JSON.parse(text) as unknown;
    },
    resolve:(decision:'continue'|'new')=>resolveApplicationChat(appConfig,chatId,decision),
    sent:()=>attempt.mock.calls.filter(([method])=>method==='messages.send').map(([,args])=>args),
    async start() {
      const ready=Promise.withResolvers<void>();
      const stop=new AbortController();
      let listener: Parameters<VkPollTransport['run']>[0];
      const transport: VkPollTransport={async run(current,signal){
        listener=current;
        await current.onGap('startup');current.onReady?.();ready.resolve();
        if (!signal.aborted) await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));
      }};
      const result=runApplication(config,logger,stop.signal,{vk:{api,transport,wait:async()=>{}},client:{complete:model},administrationIntervalMs:5});
      await ready.promise;
      return {
        event(id: number, text: string, settings: {peer?:number;author?:number;date?:number;action?:object;reply_message?:object} = {}) {
          const message={peer_id:settings.peer??owner,from_id:settings.author??owner,date:settings.date??Math.ceil(Date.now()/1000)+1,
            conversation_message_id:id,text,out:0,...(settings.action?{action:settings.action}:{}),
            ...(settings.reply_message?{reply_message:settings.reply_message}:{})};
          messages.set(`${message.peer_id}:${id}`,message);
          listener.onUpdates([{type:'message_new',group_id:groupId,object:{message}}]);
        },
        async stop(){stop.abort();expect(await result).toBeNull();},
      };
    },
    async close(){await storage.close();files.cleanup();},
  };
}

test('личка владельца назначает при выключенном боте, а повтор использует уже существующую квитанцию', async () => {
  const f=await fixture();
  let running=await f.start();
  try {
    const scope=await f.resolve('new');
    const current=f.life.current(chatId);
    await f.storage.chats.create(current,{responseMode:'silent',enabled:false,createdAt:1});
    const command=`/восстановить-админа ${chatId}@${scope.generation} ${userId}`;
    running.event(90,command,{peer});
    running.event(91,command,{peer:55,author:55});
    running.event(92,command,{reply_message:{conversation_message_id:80,from_id:55}});
    expect(f.store.status(chatId,ownerId)).toEqual([]);
    f.virtual.allowed=false;
    running.event(93,command);
    await vi.waitFor(()=>expect(f.store.status(chatId,ownerId)).toMatchObject([{result:'granted',state:'pending_delivery',reason:'unavailable'}]));
    expect(await f.localStatus()).toMatchObject({operations:[{result:'granted',state:'pending_delivery',reason:'unavailable'}]});
    expect(f.sent()).toHaveLength(0);
    expect(await f.storage.authorization.transaction(current,tx=>tx.bases(userId))).toEqual(['explicit']);
    expect(await f.storage.messages.list(current,{limit:20})).toEqual([]);
    await running.stop();
    running=await f.start();
    await f.resolve('continue');
    f.virtual.allowed=true;
    f.virtual.lookup=false;
    const operation=f.store.command(ownerId,93)!;
    running.event(94,`/повторить-подтверждение ${operation.id}`);
    await vi.waitFor(()=>expect(f.store.status(chatId,ownerId)).toMatchObject([{state:'pending_delivery',reason:'unconfirmed'}]));
    expect(f.sent()).toHaveLength(1);
    expect(f.sent()[0]).toMatchObject({peer_ids:String(owner),random_id:operation.sendId});
    running.event(94,`/повторить-подтверждение ${operation.id}`);
    f.virtual.lookup=true;
    running.event(95,`/повторить-подтверждение ${operation.id}`);
    await vi.waitFor(()=>expect(f.store.status(chatId,ownerId)).toMatchObject([{state:'delivered'}]));
    running.event(93,command);
    expect(f.sent()).toHaveLength(1);
    expect(f.model).not.toHaveBeenCalled();
    const replacement=await f.resolve('new');
    const newScope=f.life.current(chatId);
    await f.storage.chats.create(newScope,{responseMode:'silent',enabled:false,createdAt:2});
    running.event(96,command);
    await vi.waitFor(()=>expect(f.sent()).toHaveLength(2));
    expect(replacement.generation).not.toBe(scope.generation);
    expect(await f.storage.authorization.transaction(newScope,tx=>tx.bases(userId))).toEqual([]);
    expect(f.store.status(chatId,ownerId)).toEqual([]);
  } finally {await running.stop();await f.close();}
});

test('штатная сверка привязывает создателя и пригласившего к новому подключению', async () => {
  const f=await fixture();
  const running=await f.start();
  try {
    const actor=24;
    f.virtual.creator=actor;f.virtual.inviter=actor;f.virtual.joinDate=Math.floor(Date.now()/1000);
    running.event(70,'',{peer,author:actor,date:f.virtual.joinDate,action:{type:'chat_invite_user',member_id:-groupId}});
    await f.resolve('new');
    const scope=f.life.current(chatId);
    await f.storage.chats.create(scope,{responseMode:'silent',enabled:false,createdAt:1});
    await vi.waitFor(async()=>expect(await f.storage.authorization.transaction(scope,tx=>tx.bases(`vk:${actor}`)))
      .toEqual(['creator','inviter']));
    expect(f.store.communityRole(chatId)).toBe(true);
    running.event(71,'',{peer,author:actor,action:{type:'chat_kick_user',member_id:actor}});
    running.event(110,'/беседы-без-админов');
    await vi.waitFor(()=>expect(f.sent()[0]).toMatchObject({peer_ids:String(owner),
      message:expect.stringContaining(`${chatId}@${scope.generation}`)}));
    f.virtual.creator=41;
    await vi.waitFor(async()=>expect(await f.storage.authorization.transaction(scope,tx=>tx.bases('vk:41'))).toEqual(['creator']));
    expect(await f.storage.authorization.transaction(scope,tx=>tx.bases(`vk:${actor}`))).toEqual(['inviter']);
    await f.storage.authorization.transaction(scope,tx=>tx.grant({userId,basis:'explicit',grantedBy:ownerId,grantedAt:1}));
    running.event(72,'',{peer,author:candidate,action:{type:'chat_kick_user',member_id:candidate}});
    expect(await f.storage.authorization.transaction(scope,tx=>tx.bases(userId))).toEqual([]);
    expect(f.model).not.toHaveBeenCalled();
  } finally {await running.stop();await f.close();}
});
