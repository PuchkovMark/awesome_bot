import {performance} from 'node:perf_hooks';
import {expect,test} from 'vitest';
import Database from 'better-sqlite3';
import {openStorage} from '../../src/storage/index.js';
import {scopeFor} from '../helpers/connection-scope.js';
import {storageFixture} from '../helpers/storage-fixture.js';
import {catalogAdministration} from '../../src/storage/catalog-admin.js';
import {contextCapabilities} from '../helpers/context.js';
import {createContextBuilder} from '../../src/core/context/index.js';
import {recordQueueLoad} from '../helpers/queue-load-fixture.js';
test('50000 записей: индекс, ограниченные SQL-проекции и срок подготовки',async()=>{
 const f=storageFixture(),s=await openStorage(f.path),scope=scopeFor(s,'vk:loadctx'),db=new Database(f.path);
 try{
 await s.chats.create(scope,{enabled:true,responseMode:'normal',createdAt:0});const admin=catalogAdministration(s);const v=await admin.append({kind:'system_prompt',key:'k',text:'Правила',createdAt:0,expectedHead:null});if(v.status!=='created'||v.value.ref.area!=='global')throw Error();await admin.selectSystemPrompt(v.value.ref,null);
 db.transaction(()=>{const ins=db.prepare("INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp,purpose) VALUES('vk:loadctx',?,'vk:u','Имя','user',?,0,?)");for(let i=0;i<50000;i++)ins.run(String(i),'история '.repeat(50),i%2?'conversation':'service_notice');})();
 const trigger=await s.messages.append(scope,{chatId:scope.chatId,messageId:'trigger',userId:'vk:u',authorName:'',role:'user',text:'Вопрос',timestamp:100});
 db.prepare("INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp) VALUES('vk:loadctx','late','vk:u','','user',?,0)").run('ПОЗДНО'.repeat(100000));
 let pages=0,rows=0,bytes=0;
 const messages={...s.contextMessages,async page(...args:Parameters<typeof s.contextMessages.page>){pages++;const values=await s.contextMessages.page(...args);rows+=values.length;bytes+=values.reduce((n,m)=>n+Buffer.byteLength(m.text)+Buffer.byteLength(m.authorName),0);return values;}};
 const builder=createContextBuilder({messages,state:s.contextState,config:{modelContextTokens:16000},capabilities:async()=>contextCapabilities(scope.chatId),sessionId:()=> 'opaque'});
 const start=performance.now();const result=await builder.prepare({scope,messageId:trigger.id,route:{kind:'mention',mode:'normal',isGroupChat:true},signal:new AbortController().signal,isCurrent:()=>true});const elapsed=performance.now()-start;
 expect(result.kind).toBe('ready');if(result.kind!=='ready')return;
 expect(elapsed).toBeLessThan(builder.config.preparationTimeoutMs);expect(rows).toBeLessThanOrEqual(256);expect(pages).toBeLessThanOrEqual(8);expect(bytes).toBeLessThanOrEqual(rows*2*2048*4);expect(JSON.stringify(result.input)).not.toContain('ПОЗДНО');
 const plan=db.prepare("EXPLAIN QUERY PLAN SELECT id FROM messages WHERE chat_id='vk:loadctx' AND purpose='conversation' AND id<=? AND id<? ORDER BY id DESC LIMIT 32").all(trigger.id,trigger.id);expect(JSON.stringify(plan)).toContain('messages_context_order');
 await recordQueueLoad({context:true,records:50000,elapsedMs:elapsed,pages,rows,projectedBytes:bytes});
 }finally{db.close();await s.close();f.cleanup();}
});
