import { spawnSync } from 'node:child_process';
import { cpSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from 'vitest';
import { storageFixture } from './helpers/storage-fixture';
test('ESM-версии без исходников: лимиты, выбор, перезапуск и очистка', () => {
  const f = storageFixture();
  try {
    cpSync('dist', join(f.directory, 'dist'), { recursive: true });
    symlinkSync(resolve('node_modules'), join(f.directory, 'node_modules'), 'dir');
    writeFileSync(join(f.directory, 'package.json'), '{"type":"module"}');
    const url = (p: string) => JSON.stringify(pathToFileURL(join(f.directory, 'dist', p)).href);
    const code = `import {openStorage} from ${url('storage/index.js')};import {catalogAdministration} from ${url('storage/catalog-admin.js')};import {createLifecycleService} from ${url('core/index.js')};
  const path=${JSON.stringify(f.path)},options={versioning:{textMaxLength:1,maxPerEntity:2}};
  let storage=await openStorage(path,options);
  const life=()=>createLifecycleService({storage,ownerId:'vk:owner',source:{async observe(){return {confidence:'confirmed',bot:'present'};}}});
  try{
   let lifecycle=life();let scope=(await lifecycle.verify('vk:a')).scope;const admin=catalogAdministration(storage);
   const g=await admin.append({kind:'system_prompt',key:'s',text:'S',createdAt:0,expectedHead:null});await admin.selectSystemPrompt(g.value.ref,null);
   const a=await storage.versions.append(scope,{kind:'persona',key:'p',text:'A',createdAt:0,expectedHead:null});const b=await storage.versions.append(scope,{kind:'persona',key:'p',text:'B',createdAt:1,expectedHead:1});
   await storage.versions.select(scope,'persona',b.value.ref,null);await storage.versions.select(scope,'persona',a.value.ref,b.value.ref);
   let rejected=0;for(const input of [{kind:'persona',key:'p',text:'C',createdAt:2,expectedHead:2},{kind:'persona',key:'q',text:'long',createdAt:2,expectedHead:null}]){try{await storage.versions.append(scope,input);}catch(e){if(e.code==='limit_exceeded')rejected++;}}if(rejected!==2)throw Error('limits');
   await storage.close();storage=await openStorage(path,options);lifecycle=life();scope=lifecycle.current('vk:a');if((await storage.versions.selected(scope,'persona')).text!=='A')throw Error('persist');
   const next=lifecycle.decide(lifecycle.owner('vk:a','vk:owner'),'new');if(await storage.versions.selected(next,'persona'))throw Error('reset');if((await storage.versions.systemPrompt(next)).text!=='S')throw Error('catalog');
  }finally{await storage.close();}process.stdout.write('OK');`;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', code], {
      cwd: f.directory,
      env: {},
      encoding: 'utf8',
      timeout: 10000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('OK');
    expect(result.stderr).toBe('');
  } finally {
    f.cleanup();
  }
});
