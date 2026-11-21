import {expect,test} from 'vitest';
import {openStorage} from '../src/storage/index.js';
import {createLifecycleService} from '../src/core/index.js';
import type {LifecycleObservation} from '../src/contracts/index.js';
function deferred(){let resolve!:(value:LifecycleObservation)=>void;const promise=new Promise<LifecycleObservation>(r=>{resolve=r;});return{promise,resolve};}
const observed=(creatorId:'vk:a'|'vk:b'):LifecycleObservation=>({confidence:'confirmed',bot:'present',creatorId});
test.each([false,true])('два пересекающихся запроса: поздний ответ не перезаписывает принятый, reverse=%s',async reverse=>{
 const storage=await openStorage(':memory:');const a=deferred(),b=deferred();let call=0;
 const life=createLifecycleService({storage,ownerId:'vk:owner',source:{observe(){return ++call===1?Promise.resolve(observed('vk:a')):call===2?a.promise:b.promise;}}});
 try {
  const initial=(await life.verify('vk:1')).scope!;
  await storage.chats.create(initial,{responseMode: 'normal',enabled:true,createdAt:0});
  const pa=life.verify('vk:1'),pb=life.verify('vk:1');
  const first=reverse?a:b,second=reverse?b:a;const pf=reverse?pa:pb,ps=reverse?pb:pa;
  first.resolve(observed('vk:a'));const accepted=await pf;expect(accepted.status).toBe('applied');
  await storage.chats.create(accepted.scope!,{responseMode: 'normal',enabled:true,createdAt:0});
  second.resolve(observed('vk:b'));expect((await ps).status).toBe('stale');
  expect(await storage.authorization.transaction(life.current('vk:1'),tx=>tx.holder('creator'))).toBe('vk:a');
  const fresh=createLifecycleService({storage,ownerId:'vk:owner',source:{async observe(){return observed('vk:b');}}});
  await fresh.verify('vk:1');expect(await storage.authorization.transaction(fresh.current('vk:1'),tx=>tx.holder('creator'))).toBe('vk:b');
 }finally{await storage.close();}
});
test('частичный состав не снимает explicit; полный снимает; отзыв не отменяется сверкой',async()=>{
 const storage=await openStorage(':memory:');let observation:LifecycleObservation={confidence:'confirmed',bot:'present',creatorId:'vk:a',inviterId:'vk:a'};
 const life=createLifecycleService({storage,ownerId:'vk:owner',source:{async observe(){return observation;}}});
 try{
  const scope=(await life.verify('vk:1')).scope!;await storage.chats.create(scope,{responseMode: 'normal',enabled:true,createdAt:0});
  await storage.authorization.transaction(scope,tx=>tx.grant({userId:'vk:a',basis:'explicit',grantedAt:0,grantedBy:'vk:owner'}));
  observation={...observation,members:{complete:false,ids:[]}};await life.verify('vk:1');
  expect(await storage.authorization.transaction(scope,tx=>tx.bases('vk:a'))).toContain('explicit');
  observation={...observation,members:{complete:true,ids:[]}};await life.verify('vk:1');
  expect(await storage.authorization.transaction(scope,tx=>tx.bases('vk:a'))).toEqual(['creator','inviter']);
  await storage.authorization.transaction(scope,tx=>tx.revoke({userId:'vk:a',revokedBy:'vk:owner',revokedAt:1,bases:tx.bases('vk:a'),reason:'private'}));
  await life.verify('vk:1');expect(await storage.authorization.transaction(scope,tx=>tx.bases('vk:a'))).toEqual([]);
  observation={confidence:'confirmed',bot:'present',creatorChanged:true,creatorId:null};await life.verify('vk:1');
  expect(await storage.authorization.transaction(scope,tx=>tx.holder('creator'))).toBeNull();
 }finally{await storage.close();}
});
test('повреждённый ответ и ошибка источника приводят к uncertain без утечки ошибки',async()=>{
 const storage=await openStorage(':memory:');
 const life=createLifecycleService({storage,ownerId:'vk:owner',source:{async observe(){throw new Error('private');}}});
 try{expect(await life.verify('vk:1')).toEqual({status:'uncertain'});expect(()=>life.current('vk:1')).toThrow('uncertain_connection');}
 finally{await storage.close();}
});

test('отзыв во время сверки инвалидирует ответ и подтверждение участия; отмена не возвращает основания',async()=>{
 const {createAuthorizationService}=await import('../src/core/index.js');
 const storage=await openStorage(':memory:');const response=deferred();let call=0;
 const life=createLifecycleService({storage,ownerId:'vk:owner',source:{observe(){return ++call===2?response.promise:Promise.resolve(observed('vk:a'));}}});
 const auth=await createAuthorizationService({config:{ownerId:'vk:owner',reasonMaxLength:500,reasonRetentionDays:90},store:storage.authorization,now:()=>100});
 try{
  const scope=(await life.verify('vk:1')).scope!;await storage.chats.create(scope,{responseMode: 'normal',enabled:true,createdAt:0});
  const owner=auth.context({scope,userId:'vk:owner',kind:'owner'});
  const oldProof=await auth.confirmMembership(scope,'vk:new');const pending=life.verify('vk:1');
  expect((await auth.revoke(owner,'vk:a','private')).allowed).toBe(true);
  response.resolve(observed('vk:a'));expect((await pending).status).toBe('stale');
  expect(await auth.grant(owner,'vk:new',oldProof)).toEqual({allowed:false,code:'unconfirmed_member'});
  await auth.restore(owner,'vk:a');await life.verify('vk:1');
  expect(await storage.authorization.transaction(scope,tx=>tx.bases('vk:a'))).toEqual([]);
 }finally{auth.dispose();await storage.close();}
});

test('неверный ответ источника не оставляет область активной',async()=>{
 const storage=await openStorage(':memory:');
 const life=createLifecycleService({storage,ownerId:'vk:owner',source:{async observe(){return {confidence:'confirmed',bot:'present',members:{complete:'yes',ids:[]}} as unknown as LifecycleObservation;}}});
 try{expect(await life.verify('vk:1')).toEqual({status:'uncertain'});expect(()=>life.current('vk:1')).toThrow('uncertain_connection');}
 finally{await storage.close();}
});

test('подтверждённый отдельный выход снимает только explicit при неполном составе',async()=>{
 const storage=await openStorage(':memory:');let observation:LifecycleObservation={confidence:'confirmed',bot:'present',creatorId:'vk:a'};
 const life=createLifecycleService({storage,ownerId:'vk:owner',source:{async observe(){return observation;}}});
 try{
  const scope=(await life.verify('vk:1')).scope!;await storage.chats.create(scope,{responseMode: 'normal',enabled:true,createdAt:0});
  await storage.authorization.transaction(scope,tx=>tx.grant({userId:'vk:a',basis:'explicit',grantedAt:0,grantedBy:'vk:owner'}));
  observation={confidence:'confirmed',bot:'present',members:{complete:false,ids:[]},departedIds:['vk:a']};await life.verify('vk:1');
  expect(await storage.authorization.transaction(scope,tx=>tx.bases('vk:a'))).toEqual(['creator']);
 }finally{await storage.close();}
});

test('позднее подтверждение пригласившего создаёт основание ровно один раз',async()=>{
 const storage=await openStorage(':memory:');let observation:LifecycleObservation={confidence:'confirmed',bot:'present'};
 const life=createLifecycleService({storage,ownerId:'vk:owner',source:{async observe(){return observation;}}});
 try{
  const scope=(await life.verify('vk:1')).scope!;await storage.chats.create(scope,{responseMode: 'normal',enabled:true,createdAt:0});
  observation={...observation,inviterId:'vk:a'};await life.verify('vk:1');await life.verify('vk:1');
  expect(await storage.authorization.transaction(scope,tx=>tx.bases('vk:a'))).toEqual(['inviter']);
 }finally{await storage.close();}
});
