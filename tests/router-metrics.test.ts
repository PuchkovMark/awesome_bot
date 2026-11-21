import {expect,test,vi} from 'vitest';
import {createRouterMetrics} from '../src/core/message-router/metrics.js';
import {safeEvent} from '../src/logger/sanitize.js';
import type {SafeLogger} from '../src/logger/types.js';
test('счётчик unknown безопасен и отказ логгера не меняет решение',()=>{
 const event=vi.fn(()=>{throw Error('SECRET');});const metrics=createRouterMetrics({event} as unknown as SafeLogger);
 metrics.record({kind:'silence',reason:'sender_unknown'});metrics.record({kind:'silence',reason:'sender_unknown'});expect(metrics.snapshot()).toEqual({senderUnknown:2});expect(event.mock.calls[1]).toEqual([{event:'router_stats',window:'run',senderUnknown:2},'info']);
 expect(safeEvent({event:'router_stats',window:'run',senderUnknown:2,text:'SECRET',chatId:'SECRET'})).toEqual({event:'router_stats',window:'run',senderUnknown:2});
 expect(safeEvent({event:'router_stats',window:'run',senderUnknown:NaN})).toBeUndefined();
});
