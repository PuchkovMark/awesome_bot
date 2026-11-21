import {expect,test} from 'vitest';
import {openStorage} from '../src/storage/index.js';
import {createLifecycleService} from '../src/core/index.js';
import type {ConnectionScope,LifecycleObservation} from '../src/contracts/index.js';
test('область проверяется каждым чтением и записью, пауза сохраняет данные',async()=>{
 const storage=await openStorage(':memory:');let result:LifecycleObservation={confidence:'confirmed',bot:'present'};
 const life=createLifecycleService({storage,ownerId:'vk:owner',source:{async observe(){return result;}}});
 try {
  const scope=(await life.verify('vk:1')).scope!;
  await storage.scoped.messages.append(scope,{chatId:'vk:1',userId:'vk:2',messageId:'1',authorName:'',role:'user',text:'keep',timestamp:0});
  await expect(storage.scoped.chats.get({...scope} as ConnectionScope)).rejects.toMatchObject({code:'invalid_input'});
  await expect(storage.scoped.messages.append(scope,{chatId:'vk:other',userId:'vk:2',messageId:'2',authorName:'',role:'user',text:'bad',timestamp:0})).rejects.toMatchObject({code:'invalid_input'});
  result={confidence:'uncertain',bot:'present'};await life.verify('vk:1');
  await expect(storage.scoped.messages.list(scope,{limit:5})).rejects.toMatchObject({code:'uncertain_connection'});
  life.decide(life.owner('vk:1','vk:owner'),'continue');
  expect(await storage.scoped.messages.list(scope,{limit:5})).toMatchObject([{text:'keep'}]);
 } finally {await storage.close();}
});
