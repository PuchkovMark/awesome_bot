import { expect,test } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { createLifecycleService } from '../src/core/index.js';
import type { LifecycleObservation } from '../src/contracts/index.js';
test('неопределённость сохраняется до решения владельца; контекст нельзя скопировать',async()=>{
 const storage=await openStorage(':memory:');let observation:LifecycleObservation={confidence:'confirmed',bot:'present'};
 const service=createLifecycleService({storage,ownerId:'vk:owner',source:{async observe(){return observation;}}});
 try {
  const first=await service.verify('vk:1');expect(first.status).toBe('applied');
  observation={confidence:'uncertain',bot:'present'};expect((await service.verify('vk:1')).status).toBe('uncertain');
  expect(()=>service.current('vk:1')).toThrow('uncertain_connection');
  observation={confidence:'confirmed',bot:'present'};expect((await service.verify('vk:1')).status).toBe('uncertain');
  expect(()=>service.owner('vk:1','vk:other')).toThrow('forbidden');
  const proof=service.owner('vk:1','vk:owner');expect(()=>service.decide({...proof},'continue')).toThrow('forbidden');
  expect(service.decide(proof,'continue').generation).toBe(first.scope!.generation);
 } finally {await storage.close();}
});
