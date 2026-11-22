import {expect,test} from 'vitest';
import {openStorage} from '../../src/storage/index.js';
import {createChatQueue} from '../../src/core/chat-queue/service.js';
import {queueConfig} from '../../src/core/chat-queue/validation.js';
import {createTraceMaintenance} from '../../src/core/response-tracing/diagnostics.js';
import {scopeFor} from '../helpers/connection-scope.js';
import {queueMessage,flushQueue} from '../helpers/chat-queue.js';
import {storageFixture} from '../helpers/storage-fixture.js';
import {recordQueueLoad} from '../helpers/queue-load-fixture.js';
test('крупные трассировки, четыре чата и очистка укладываются в владение',async()=>{
 const f=storageFixture(),s=await openStorage(f.path);const config=queueConfig({maxQueuedTotal:200,maxQueuedPerChat:40});let completed=0,maxWriteMs=0;
 const scopes=Array.from({length:4},(_,i)=>scopeFor(s,'vk:trace'+i));
 const q=createChatQueue({storage:s,tracing:{messageRetentionDays:30},config,handler:async w=>{
 const started=performance.now();w.recordTrace({prompt:{area:'global',kind:'system_prompt',key:'load',version:1},context:{version:{area:'global',kind:'system_prompt',key:'load',version:1},cutoffId:w.messageId,messageIds:Array.from({length:3500},(_,i)=>Number.MAX_SAFE_INTEGER-i),layerBytes:{system:1,environment:1,messages:1},estimatedTokens:1,scanned:3500,historyTruncated:true,reply:'none',absentLayers:['persona']}});maxWriteMs=Math.max(maxWriteMs,performance.now()-started);completed++;return 'completed';}});
 try{await q.start();for(let i=0;i<100;i++){const scope=scopes[i%4]!;const r=await q.admit(scope,queueMessage(scope.chatId,String(i)),()=>true);expect(r.status).toBe('queued');}for(let i=0;i<20;i++)await flushQueue();expect(completed).toBe(100);await q.stop();expect(q.traceStats().trace_write_failed).toBe(0);
 const metrics=q.traceStats();const m=createTraceMaintenance(s);let deleted=0,maxPruneMs=0;for(const scope of scopes){const row=await s.traces.last(scope);expect(Buffer.byteLength(JSON.stringify(row?.payload))).toBeGreaterThan(59000);const started=performance.now();deleted+=m.prune(scope,Date.now()+8*86400000,100).deleted;maxPruneMs=Math.max(maxPruneMs,performance.now()-started);}expect(deleted).toBe(100);expect(q.traceStats()).toEqual(metrics);expect(maxWriteMs).toBeLessThan(config.renewIntervalMs);expect(maxPruneMs).toBeLessThan(config.renewIntervalMs);await recordQueueLoad({tracing:true,completed,maxWriteMs,maxPruneMs,deleted});
 }finally{await q.stop();await s.close();f.cleanup();}
});
