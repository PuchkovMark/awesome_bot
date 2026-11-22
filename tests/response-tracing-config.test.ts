import {expect,test} from 'vitest';
import {traceConfig} from '../src/core/response-tracing/config.js';
import {initialTrace,minimalTrace} from '../src/storage/trace-store.js';
import {encodeTrace} from '../src/storage/trace-validation.js';
test('срок сообщений обязателен и больше срока трассировки',()=>{
 expect(traceConfig({messageRetentionDays:30})).toEqual({messageRetentionDays:30,retentionDays:7,maxRecordBytes:65536});
 for(const c of [{messageRetentionDays:7},{messageRetentionDays:6},{messageRetentionDays:30,maxRecordBytes:100},{messageRetentionDays:Infinity}])expect(()=>traceConfig(c)).toThrow('invalid_configuration');
});
test('форма отклоняет текст и getters, предел измеряется UTF8, минимальная форма не подделывает размеры',()=>{
 const p=initialTrace();expect(()=>encodeTrace({...p,text:'SECRET'},65536)).toThrow();
 let called=false;const x={...p};Object.defineProperty(x,'summary',{get(){called=true;return null;}});expect(()=>encodeTrace(x,65536)).toThrow();expect(called).toBe(false);
 const n=Buffer.byteLength(encodeTrace(p,65536));expect(encodeTrace(p,n)).toBeTypeOf('string');expect(()=>encodeTrace(p,n-1)).toThrow('limit_exceeded');
 const min=minimalTrace(p,'write_failed');expect(min.context).toBeNull();expect(min.degraded).toBe(true);
 const worst={...p,model:{name:'\u0000'.repeat(1024),invoked:'possible' as const},prompt:{area:'global' as const,kind:'system_prompt' as const,key:'\u0000'.repeat(1024),version:Number.MAX_SAFE_INTEGER}};
 expect(Buffer.byteLength(encodeTrace(minimalTrace(worst,'write_failed'),16384))).toBeLessThan(16384);
});
