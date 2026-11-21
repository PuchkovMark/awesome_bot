import { expect, test } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { createChatQueue } from '../src/core/index.js';
import { scopeFor } from './helpers/connection-scope.js';
import type { ChatId } from '../src/contracts/index.js';
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
export const input=(chatId:ChatId,id:string)=>({chatId,messageId:id,userId:'vk:u' as const,authorName:'',text:id,role:'user' as const,timestamp:0});
test('один чат FIFO, другие параллельны, ошибка не останавливает',async()=>{
 const storage=await openStorage(':memory:');const a=scopeFor(storage,'vk:a'),b=scopeFor(storage,'vk:b');
 const calls:string[]=[];const releases:(()=>void)[]=[];
 const q=createChatQueue({storage,handler:async work=>{
   const m=await storage.messages.get(work.scope,work.messageId);calls.push(m!.chatId+':'+m!.text);
   await new Promise<void>(resolve=>releases.push(resolve));if(m!.text==='bad')throw Error('private');return 'completed';
 }});
 try{
 await q.start();await q.admit(a,input('vk:a','bad'),()=>true);await flush();
 await q.admit(a,input('vk:a','2'),()=>true);await q.admit(b,input('vk:b','1'),()=>true);await flush();
 expect(calls).toEqual(['vk:a:bad','vk:b:1']);releases[0]!();await flush();expect(calls).toEqual(['vk:a:bad','vk:b:1','vk:a:2']);
 releases[1]!();releases[2]!();await flush();expect(q.stats().depthRunning).toBe(0);
 }finally{await q.stop();await storage.close();}
});
