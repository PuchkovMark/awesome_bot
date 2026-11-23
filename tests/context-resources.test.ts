import {expect,test,vi} from 'vitest';
import {contextFixture} from './helpers/context';
import {createContextBuilder} from '../src/core/context/index';
test('повторные отмены и таймауты освобождают таймеры и не возвращают поздний ready',async()=>{
 vi.useFakeTimers();const f=await contextFixture();try{
 const a=await f.put('a','вопрос');const b=createContextBuilder({...f.options,capabilities:()=>new Promise(()=>{}),config:{modelContextTokens:16000,preparationTimeoutMs:10}});
 const before=vi.getTimerCount();for(let i=0;i<20;i++){const pending=b.prepare(f.work(a.id));await vi.advanceTimersByTimeAsync(10);expect(await pending).toEqual({kind:'deadline_exceeded'});}
 expect(vi.getTimerCount()).toBe(before);expect(b.stats().deadline_exceeded).toBe(20);
 }finally{await f.storage.close();vi.useRealTimers();}
});
