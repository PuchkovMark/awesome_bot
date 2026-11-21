import { StorageError } from '../../storage/errors.js';
import { randomUUID } from 'node:crypto';
import { queueBackend } from '../../storage/queue-registry.js';
import type { QueueWork } from '../../storage/queue-types.js';
import { QueueError } from './errors.js';
import { queueConfig } from './validation.js';
import type { ChatQueue, ChatQueueOptions, QueueOutcome, QueueStats } from './types.js';
const outcomes = new Set<unknown>(['completed','failed','rate_limit','interrupted','expired','message_missing','deadline_exceeded']);
interface Task { deadline: number; work: QueueWork; controller: AbortController; timer: ReturnType<typeof setTimeout>; done: boolean }
function safeFailure(error: unknown): QueueError {
  // Не читать произвольные свойства ошибок внедрённого обработчика.
  if (error instanceof QueueError) return error;
  if (error instanceof StorageError) {
    if(error.code==='queue_lost_ownership') return new QueueError('lost_ownership');
    if(error.code==='queue_owned') return new QueueError('owned');
    if(['invalid_input','stale_scope','uncertain_connection'].includes(error.code)) return new QueueError('invalid_input');
  }
  return new QueueError('storage_failed');
}
export function createChatQueue(options: ChatQueueOptions): ChatQueue {
  if (!options || typeof options.handler !== 'function') throw new QueueError('invalid_input');
  const config = queueConfig(options.config);
  const backend = queueBackend(options.storage);
  const readMessage = options.storage.messages.get.bind(options.storage.messages);
  const handler = options.handler;
  const log = options.logger?.event.bind(options.logger);
  let phase: 'idle'|'running'|'stopping'|'stopped'|'failed' = 'idle';
  let token = '', renewAt = 0, scheduled = false, stopDeadline = Infinity;
  let tick: ReturnType<typeof setTimeout>|undefined, stopTimer: ReturnType<typeof setTimeout>|undefined;
  let stopPromise: Promise<void>|undefined, resolveStop: (()=>void)|undefined, rejectStop: ((error:QueueError)=>void)|undefined;
  let failure: QueueError|undefined;
  const tasks = new Map<number,Task>();
  const counters = {depthQueued:0,depthRunning:0,waitCount:0,waitTotalMs:0,waitMaxMs:0,rejected:0,expired:0,interrupted:0};
  const add = (a:number,b:number) => Math.min(Number.MAX_SAFE_INTEGER,a+b);
  function wait(ms:number) { counters.waitCount=add(counters.waitCount,1); counters.waitTotalMs=add(counters.waitTotalMs,ms); counters.waitMaxMs=Math.max(counters.waitMaxMs,ms); }
  function emit() {
    Object.assign(counters,backend.depth(token));
    try { log?.({event:'queue_stats',window:'run',...counters},'info'); } catch { /* Диагностика не меняет обработку. */ }
  }
  function clearTimers() { clearTimeout(tick); tick=undefined; clearTimeout(stopTimer); stopTimer=undefined; }
  function fault(error:unknown) {
    if (phase==='failed' || phase==='stopped') return;
    failure=safeFailure(error); phase='failed'; clearTimers();
    for(const task of tasks.values()) { task.done=true;clearTimeout(task.timer);task.controller.abort(); }
    tasks.clear(); rejectStop?.(failure);
  }
  function completeStop() {
    if(phase!=='stopping' || tasks.size) return;
    try { emit(); backend.release(token); phase='stopped'; clearTimers(); resolveStop?.(); }
    catch(error){ fault(error); }
  }
  function schedule() {
    if(scheduled || phase!=='running') return;
    scheduled=true;
    queueMicrotask(()=>{scheduled=false;if(phase==='running')pump();});
  }
  function finish(task:Task, outcome:QueueOutcome) {
    if(task.done)return;
    const now=performance.now();
    if(outcome!=='interrupted') {
      if(phase==='stopping' && now>=stopDeadline && stopDeadline<=task.deadline)outcome='interrupted';
      else if(now>=task.deadline)outcome='deadline_exceeded';
    }
    task.done=true;clearTimeout(task.timer);tasks.delete(task.work.id);
    if(outcome==='interrupted'||outcome==='deadline_exceeded')task.controller.abort();
    try {
      const actual = backend.valid(token,task.work)?outcome:'interrupted';
      const committed=backend.finish(token,task.work,actual);
      if(committed==='interrupted')counters.interrupted=add(counters.interrupted,1);
      emit();
      if(phase==='stopping')completeStop();else schedule();
    }catch(error){task.controller.abort();fault(error);}
  }
  function launch(work:QueueWork) {
    wait(Math.max(0,Date.now()-work.receivedAt));
    const controller=new AbortController();
    const task:Task={deadline:performance.now()+config.handlerTimeoutMs,work,controller,done:false,timer:setTimeout(()=>finish(task,'deadline_exceeded'),config.handlerTimeoutMs)};
    tasks.set(work.id,task);
    void Promise.resolve().then(async()=>{
      if(task.done)return;
      const message=await readMessage(work.scope,work.messageId);
      if(task.done)return;
      if(!message){finish(task,'message_missing');return;}
      if(!backend.valid(token,work)){finish(task,'interrupted');return;}
      const outcome:unknown=await handler(Object.freeze({scope:work.scope,messageId:work.messageId,signal:controller.signal}));
      finish(task,outcomes.has(outcome)?outcome as QueueOutcome:'failed');
    }).catch(()=>finish(task,'failed'));
  }
  function pump() {
    if(phase!=='running' && phase!=='stopping')return;
    try {
      backend.check(token);
      if(performance.now()>=renewAt){ backend.renew(token,config.leaseMs);renewAt=performance.now()+config.renewIntervalMs; }
      for(const task of [...tasks.values()])if(!backend.valid(token,task.work))finish(task,'interrupted');
      if(phase==='running') {
        const expired=backend.expire(token);counters.expired=add(counters.expired,expired.length);expired.forEach(wait);
        while(tasks.size<config.maxConcurrentChats) {
          const work=backend.take(token);if(!work)break;launch(work);
        }
        emit();
      }
    }catch(error){fault(error);}
  }
  function armTick() {
    if(phase!=='running' && phase!=='stopping')return;
    tick=setTimeout(()=>{tick=undefined;pump();armTick();},Math.max(1,Math.min(1000,config.renewIntervalMs)));
    tick.unref();
  }
  const service: ChatQueue = {
    async start() {
      if(phase!=='idle')throw new QueueError('stopped');
      token=randomUUID();
      try { counters.interrupted=backend.acquire(token,config.leaseMs,config.renewIntervalMs); }
      catch(error) { throw safeFailure(error); }
      phase='running';renewAt=performance.now()+config.renewIntervalMs;pump();armTick();
      if(failure)throw failure;
    },
    async admit(scope,message,decision) {
      if(phase!=='running')return {status:'stopped' as const};
      try {
        const expired=backend.expire(token); counters.expired=add(counters.expired,expired.length);expired.forEach(wait);
        const result=backend.admit(token,scope,message,decision,config);
        if(result.status==='queue_full')counters.rejected=add(counters.rejected,1);
        emit();schedule();return Object.freeze(result);
      }catch(error){
        // Ошибка ввода/области не останавливает здоровую очередь; потеря владения обнаруживается отдельно.
        try{backend.check(token);}catch(fatal){fault(fatal);}
        throw safeFailure(error);
      }
    },
    stop() {
      if(stopPromise)return stopPromise;
      if(phase==='failed')return Promise.reject(failure);
      if(phase==='idle'||phase==='stopped'){phase='stopped';return Promise.resolve();}
      stopPromise=new Promise<void>((resolve,reject)=>{resolveStop=resolve;rejectStop=reject;});
      phase='stopping';stopDeadline=performance.now()+config.stopTimeoutMs;
      stopTimer=setTimeout(()=>{for(const task of [...tasks.values()])finish(task,'interrupted');completeStop();},config.stopTimeoutMs);
      completeStop();return stopPromise;
    },
    stats():QueueStats { if(phase==='running'||phase==='stopping')emit();return Object.freeze({...counters}); },
  };
  return Object.freeze(service);
}
