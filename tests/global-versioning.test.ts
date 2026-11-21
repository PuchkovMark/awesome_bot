import {expect,test} from 'vitest';
import {openStorage} from '../src/storage/index.js';
import {catalogAdministration} from '../src/storage/catalog-admin.js';
import type {ContentKind,GlobalVersionRef} from '../src/contracts/versioning.js';
test('общие виды, конфликты, точный выбор/откат и оба лимита',async()=>{
 const storage=await openStorage(':memory:',{versioning:{textMaxLength:2,maxPerEntity:2}}),admin=catalogAdministration(storage);
 try{
  for(const kind of ['system_prompt','persona','greeting_template'] as ContentKind[]){
   const one=await admin.append({kind,key:'same',text:'я😀',createdAt:1,expectedHead:null});expect(one.status).toBe('created');if(one.status!=='created')throw Error();
   expect(await admin.append({kind,key:'same',text:'',createdAt:2,expectedHead:null})).toEqual({status:'conflict'});
   const two=await admin.append({kind,key:'same',text:'',createdAt:2,expectedHead:1});expect(two.status).toBe('created');
   await expect(admin.append({kind,key:'same',text:'x',createdAt:3,expectedHead:2})).rejects.toMatchObject({code:'limit_exceeded'});
   await expect(admin.append({kind,key:'new',text:'private',createdAt:3,expectedHead:null})).rejects.toMatchObject({code:'limit_exceeded',message:'Storage: limit_exceeded'});
   expect((await admin.get(one.value.ref as GlobalVersionRef))!.text).toBe('я😀');
  }
  const a:GlobalVersionRef={area:'global',kind:'system_prompt',key:'same',version:1},b={...a,version:2};
  expect(await admin.systemPrompt()).toBeNull();expect(await admin.selectSystemPrompt(a,null)).toEqual({status:'selected'});
  expect(await admin.selectSystemPrompt(b,null)).toEqual({status:'conflict'});await admin.selectSystemPrompt(b,a);expect((await admin.systemPrompt())!.text).toBe('');
  await admin.selectSystemPrompt(a,b);expect((await admin.systemPrompt())!.ref).toEqual(a);
  expect(await admin.selectSystemPrompt({...a,key:'missing'},a)).toEqual({status:'not_found'});expect((await admin.systemPrompt())!.ref).toEqual(a);
  await admin.resetSystemPrompt(a);expect(await admin.systemPrompt()).toBeNull();
  expect(Object.keys(admin).sort()).toEqual(['append','get','resetSystemPrompt','selectSystemPrompt','systemPrompt']);
 }finally{await storage.close();}
 await expect(admin.systemPrompt()).rejects.toMatchObject({code:'closed'});
});
