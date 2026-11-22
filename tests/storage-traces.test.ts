import {expect,test} from 'vitest';
import Database from 'better-sqlite3';
import {openStorage} from '../src/storage/index.js';
import {scopeFor} from './helpers/connection-scope.js';
import {storageFixture} from './helpers/storage-fixture.js';
import {initialTrace,traceBackend} from '../src/storage/trace-store.js';
test('чтение scoped, заморожено и отфильтровано по сроку; удаление источника каскадное',async()=>{
 const f=storageFixture();const s=await openStorage(f.path);const db=new Database(f.path);try{
 const scope=scopeFor(s,'vk:a'),other=scopeFor(s,'vk:b');await s.messages.append(scope,{chatId:'vk:a',messageId:'m',userId:'vk:u',authorName:'',role:'user',text:'SECRET',timestamp:0});
 const id=(await s.messages.list(scope,{limit:1}))[0]!.id;const now=Date.now();
 db.prepare("INSERT INTO queue_jobs(chat_id,generation,message_id,received_at,expires_at,state,outcome) VALUES(?,?,?,?,?,'terminal','completed')").run(scope.chatId,scope.generation,id,now,now+1000);
 db.prepare('INSERT INTO response_traces VALUES(1,?,?,?,?,?,?,?,?)').run(scope.chatId,scope.generation,id,now,now,now+10000,'completed',JSON.stringify(initialTrace()));
 const t=await s.traces.get(scope,1);expect(t?.outcome).toBe('completed');expect(Object.isFrozen(t?.payload.model)).toBe(true);expect(await s.traces.last(other)).toBeNull();
 await expect(s.traces.get({...scope},1)).rejects.toThrow();expect(await s.traces.last(scope)).toEqual(t);
 db.prepare('UPDATE response_traces SET expires_at=?').run(now+1);expect(traceBackend(s).prune(scope,now+2,1)).toEqual({deleted:1,more:false});expect(await s.traces.last(scope)).toBeNull();
 db.prepare('INSERT INTO response_traces VALUES(1,?,?,?,?,?,?,?,?)').run(scope.chatId,scope.generation,id,now,now,now+10000,'completed',JSON.stringify(initialTrace()));db.pragma('foreign_keys=ON');db.prepare('DELETE FROM messages WHERE id=?').run(id);expect(await s.traces.last(scope)).toBeNull();
 }finally{db.close();await s.close();f.cleanup();}
});
