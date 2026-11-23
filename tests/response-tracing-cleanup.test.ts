import {expect,test,vi} from 'vitest';
import {openStorage} from '../src/storage/index';
import {scopeFor} from './helpers/connection-scope';
import {queueBackend} from '../src/storage/queue-registry';
import {queueConfig} from '../src/core/chat-queue/validation';
import {queueMessage} from './helpers/chat-queue';
import {createTraceMaintenance} from '../src/core/response-tracing/diagnostics';
import {createTraceMetrics} from '../src/core/response-tracing/metrics';
test('истечение скрывает чтение, порционная очистка не меняет независимые метрики',async()=>{
 vi.useFakeTimers();vi.setSystemTime(1000);const s=await openStorage(':memory:');try{
 const scope=scopeFor(s,'vk:a'),q=queueBackend(s);q.acquire('a',10000,100);for(let i=0;i<3;i++){q.admit('a',scope,queueMessage('vk:a',String(i)),()=>true,queueConfig());q.finish('a',q.take('a')!,'completed');}q.release('a');const metrics=createTraceMetrics();metrics.record('full_write_failed');const snapshot=metrics.snapshot();
 expect(await s.traces.last(scope)).not.toBeNull();vi.setSystemTime(8*86400000);expect(await s.traces.last(scope)).toBeNull();const m=createTraceMaintenance(s);expect(m.prune(scope,Date.now(),2)).toEqual({deleted:2,more:true});expect(m.prune(scope,Date.now(),2)).toEqual({deleted:1,more:false});expect(metrics.snapshot()).toEqual(snapshot);expect(await s.messages.list(scope,{limit:10})).toHaveLength(3);
 }finally{await s.close();vi.useRealTimers();}
});
