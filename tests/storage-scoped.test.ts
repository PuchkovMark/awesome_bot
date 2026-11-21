import {expect,test} from 'vitest';
import {openStorage} from '../src/storage/index.js';
import {createLifecycleService} from '../src/core/index.js';
import type {ConnectionScope,LifecycleObservation} from '../src/contracts/index.js';
test('область проверяется каждым чтением и записью, пауза сохраняет данные',async()=>{
 const storage=await openStorage(':memory:');let result:LifecycleObservation={confidence:'confirmed',bot:'present'};
 const life=createLifecycleService({storage,ownerId:'vk:owner',source:{async observe(){return result;}}});
 try {
  const scope=(await life.verify('vk:1')).scope!;
  await storage.messages.append(scope,{chatId:'vk:1',userId:'vk:2',messageId:'1',authorName:'',role:'user',text:'keep',timestamp:0});
  await expect(storage.chats.get({...scope} as ConnectionScope)).rejects.toMatchObject({code:'invalid_input'});
  await expect(storage.messages.append(scope,{chatId:'vk:other',userId:'vk:2',messageId:'2',authorName:'',role:'user',text:'bad',timestamp:0})).rejects.toMatchObject({code:'invalid_input'});
  result={confidence:'uncertain',bot:'present'};await life.verify('vk:1');
  await expect(storage.messages.list(scope,{limit:5})).rejects.toMatchObject({code:'uncertain_connection'});
  life.decide(life.owner('vk:1','vk:owner'),'continue');
  expect(await storage.messages.list(scope,{limit:5})).toMatchObject([{text:'keep'}]);
 } finally {await storage.close();}
});

test('пауза отклоняет все запросные операции, old owner не переносится на новое поколение',async()=>{
 const {createAuthorizationService}=await import('../src/core/index.js');
 const storage=await openStorage(':memory:');let result:LifecycleObservation={confidence:'confirmed',bot:'present'};
 const life=createLifecycleService({storage,ownerId:'vk:owner',source:{async observe(){return result;}}});
 const auth=await createAuthorizationService({config:{ownerId:'vk:owner',reasonMaxLength:500,reasonRetentionDays:90},store:storage.authorization,now:()=>100});
 try{
  const scope=(await life.verify('vk:1')).scope!;await storage.chats.create(scope,{responseMode:'mention',enabled:true,createdAt:0});
  const owner=auth.context({scope,userId:'vk:owner',kind:'owner'});
  result={confidence:'uncertain',bot:'unknown'};await life.verify('vk:1');
  for(const operation of [()=>storage.messages.list(scope,{limit:1}),()=>storage.chats.get(scope),()=>storage.chats.create(scope,{responseMode:'mention',enabled:true,createdAt:0}),()=>storage.chats.update(scope,{title:'bad'}),()=>storage.authorization.transaction(scope,tx=>tx.bases('vk:a')),()=>auth.check(owner,'admin.grant')])await expect(operation()).rejects.toMatchObject({code:'uncertain_connection'});
  const next=life.decide(life.owner('vk:1','vk:owner'),'new');
  await expect(auth.check(owner,'admin.grant')).rejects.toMatchObject({code:'stale_scope'});
  await storage.chats.create(next,{responseMode:'mention',enabled:true,createdAt:0});
  expect((await storage.chats.get(next))!.title).toBeNull();
 }finally{auth.dispose();await storage.close();}
});
