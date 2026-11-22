import {expect,test,vi} from 'vitest';
import Database from 'better-sqlite3';
import {openStorage} from '../src/storage/index.js';
import {scopeFor} from './helpers/connection-scope.js';
import {storageFixture} from './helpers/storage-fixture.js';
import {queueBackend} from '../src/storage/queue-registry.js';
import {queueConfig} from '../src/core/chat-queue/validation.js';
import {queueMessage} from './helpers/chat-queue.js';
const config=queueConfig();
test('старт/закрытие/повтор и восстановление: одна трассировка на задание',async()=>{
 const f=storageFixture();let s=await openStorage(f.path);const scope=scopeFor(s,'vk:a');const q=queueBackend(s);q.acquire('one',10000,100);
 const job=q.admit('one',scope,queueMessage('vk:a','m'),()=>true,config);if(job.status!=='queued')throw Error();const work=q.take('one')!;
 expect((await s.traces.get(scope,job.jobId))?.finishedAt).toBeNull();q.release('one');await s.close();s=await openStorage(f.path);
 try{const next=queueBackend(s);expect(next.acquire('two',10000,100)).toBe(1);const recovered=await s.traces.get(scopeFor(s,'vk:a'),job.jobId);expect(recovered?.outcome).toBe('interrupted');expect(recovered?.payload.publication.reaction).toBe('silence');expect(next.finish('two',work,'completed')).toBeNull();next.release('two');}finally{await s.close();f.cleanup();}
});
test('ошибка INSERT откатывает running, ошибка закрытия допускает минимальную форму',async()=>{
 const f=storageFixture(),s=await openStorage(f.path),db=new Database(f.path);try{
 const scope=scopeFor(s,'vk:a'),q=queueBackend(s);q.acquire('a',10000,100);const job=q.admit('a',scope,queueMessage('vk:a','m'),()=>true,config);if(job.status!=='queued')throw Error();
 db.exec("CREATE TRIGGER fail_start BEFORE INSERT ON response_traces BEGIN SELECT RAISE(ABORT,'SECRET'); END;");expect(()=>q.take('a')).toThrow('operation_failed');expect((await s.queue.get(scope,job.jobId))?.state).toBe('queued');db.exec('DROP TRIGGER fail_start');const work=q.take('a')!;
 db.exec("CREATE TRIGGER fail_full BEFORE UPDATE ON response_traces WHEN json_extract(NEW.payload,'$.degraded')=0 BEGIN SELECT RAISE(ABORT,'SECRET'); END;");expect(q.finish('a',work,'completed')).toBe('completed');expect((await s.traces.get(scope,job.jobId))?.payload.degraded).toBe(true);expect(q.finish('a',work,'failed')).toBeNull();q.release('a');
 }finally{db.close();await s.close();f.cleanup();}
});
test('двойной отказ не фиксирует противоречащие terminal и trace',async()=>{
 const f=storageFixture(),s=await openStorage(f.path),db=new Database(f.path);try{
 const scope=scopeFor(s,'vk:a'),q=queueBackend(s);q.acquire('a',10000,100);q.admit('a',scope,queueMessage('vk:a','m'),()=>true,config);const work=q.take('a')!;db.exec("CREATE TRIGGER fail_all BEFORE UPDATE ON response_traces BEGIN SELECT RAISE(ABORT,'SECRET'); END;");expect(()=>q.finish('a',work,'completed')).toThrow('operation_failed');expect((await s.queue.get(scope,work.id))?.state).toBe('running');expect((await s.traces.get(scope,work.id))?.finishedAt).toBeNull();db.exec('DROP TRIGGER fail_all');q.release('a');
 }finally{db.close();await s.close();f.cleanup();}
});
test('после удаления поколения поздний результат не воссоздаёт запись',async()=>{
 const s=await openStorage(':memory:');try{const scope=scopeFor(s,'vk:a'),q=queueBackend(s);q.acquire('a',10000,100);q.admit('a',scope,queueMessage('vk:a','m'),()=>true,config);const work=q.take('a')!;q.finish('a',work,'completed');q.release('a');const {lifecycleBackend}=await import('../src/storage/lifecycle-store.js');const l=lifecycleBackend(s);l.ownerDecision(l.begin('vk:a'),'new');q.acquire('b',10000,100);expect(q.finish('b',work,'completed')).toBeNull();expect(await s.traces.last(scopeFor(s,'vk:a'))).toBeNull();q.release('b');}finally{await s.close();vi.useRealTimers();}
});
