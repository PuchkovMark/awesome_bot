import {expect,test} from 'vitest';
import {loadConfig} from '../src/config/index.js';
import {defaultVersionLimits,versionLimits,versionText} from '../src/storage/version-limits.js';
const env={VK_TOKEN:'synthetic',OPENCODE_API_KEY:'synthetic',LLM_MODEL:'model',BOT_OWNER_ID:'vk:owner'};
test('общие defaults, Unicode и буквальная граница',()=>{
 expect(loadConfig({env,readFile:()=>''}).config.versioning).toEqual(defaultVersionLimits);
 const limits=versionLimits({textMaxLength:2,maxPerEntity:1});versionText('я😀',limits);versionText('',limits);
 expect(()=>versionText('я😀x',limits)).toThrow('limit_exceeded');
});
test.each(['0','-1','1.5','','9007199254740992','private'])('отклоняет неверный предел %j',value=>{
 for(const name of ['VERSION_TEXT_MAX_LENGTH','VERSION_MAX_PER_ENTITY'])expect(()=>loadConfig({env:{...env,[name]:value},readFile:()=>''})).toThrow(name);
 expect(()=>versionLimits({textMaxLength:Number(value),maxPerEntity:1})).toThrow('invalid_input');
});
test('значения файла и приоритет env',()=>{
 expect(loadConfig({env:{...env,VERSION_MAX_PER_ENTITY:'3'},readFile:()=> 'VERSION_TEXT_MAX_LENGTH=4\nVERSION_MAX_PER_ENTITY=5'}).config.versioning).toEqual({textMaxLength:4,maxPerEntity:3});
});

test('ошибки getter и неизвестные options безопасны и не открывают БД',async()=>{
 const {openStorage}=await import('../src/storage/index.js');const {storageFixture}=await import('./helpers/storage-fixture.js');const {existsSync}=await import('node:fs');const f=storageFixture();
 try{
  await expect(openStorage(f.path,{get versioning():never{throw new Error('private text');}})).rejects.toMatchObject({code:'invalid_input',message:'Storage: invalid_input'});
  expect(()=>versionLimits({get textMaxLength():never{throw new Error('private text');},maxPerEntity:1})).toThrow('Storage: invalid_input');
  expect(existsSync(f.path)).toBe(false);
 }finally{f.cleanup();}
});
