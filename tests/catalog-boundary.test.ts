import {mkdirSync,writeFileSync,cpSync,symlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {expect,test} from 'vitest';
import {checkCatalogBoundary} from '../scripts/check-catalog-boundary.mjs';
import {storageFixture} from './helpers/storage-fixture.js';
function fixture(){const f=storageFixture();const put=(p:string,text:string)=>{mkdirSync(join(f.directory,p,'..'),{recursive:true});writeFileSync(join(f.directory,p),text);};put('tsconfig.json',JSON.stringify({compilerOptions:{module:'NodeNext',moduleResolution:'NodeNext',baseUrl:'.',paths:{'@catalog':['src/storage/catalog-admin.ts']}},include:['src/**/*.ts']}));put('src/storage/catalog-admin.ts','export const admin=1;');symlinkSync(resolve('node_modules'),join(f.directory,'node_modules'),'dir');return {...f,put};}
test.each(["import '../storage/catalog-admin.js';","export * from '../storage/catalog-admin.js';","import type {A} from '../storage/catalog-admin.js';","type A=import('../storage/catalog-admin.js').A;","import A=require('../storage/catalog-admin.js');","void import('../storage/catalog-admin.js');","require('../storage/catalog-admin.js');","import '@catalog';","void import(target);"] )('граф отклоняет доступ %s',code=>{
 const f=fixture();try{f.put('src/core/context.ts',"import '../helper.js';");f.put('src/helper.ts',"export * from './bridge.js';");f.put('src/bridge.ts',code.replaceAll('../storage/','./storage/'));expect(checkCatalogBoundary(f.directory)).toHaveLength(1);}finally{f.cleanup();}
});
test('все корни защищены; запросный reader и композиция разрешены',()=>{
 const f=fixture();try{for(const root of ['tools/a.ts','commands/a.ts','core/commands/a.ts','context/a.ts','core/context/a.ts','core/context.ts']){f.put('src/'+root,"import '@catalog';");}expect(checkCatalogBoundary(f.directory)).toHaveLength(6);
 }finally{f.cleanup();}
 const good=fixture();try{good.put('src/tools/a.ts',"import '../storage/index.js';");good.put('src/storage/index.ts','export const reader=1;');good.put('src/main.ts',"import '@catalog';");expect(checkCatalogBoundary(good.directory)).toEqual([]);}finally{good.cleanup();}
});
test('проверка графа останавливает команду сборки',()=>{
 const f=fixture();try{f.put('src/tools/a.ts',"import '@catalog';");cpSync('scripts/check-catalog-boundary.mjs',join(f.directory,'check.mjs'));const build=JSON.parse(requirePackage()).scripts.build as string;const checkIndex=build.indexOf('npm run check:catalog');expect(checkIndex).toBeGreaterThan(0);expect(checkIndex).toBeLessThan(build.indexOf('npm run typecheck'));
 f.put('package.json',JSON.stringify({type:'module',scripts:{build,lint:'node -e ""','check:catalog':'node check.mjs',typecheck:'node -e "process.stdout.write(\'UNREACHABLE\')"'}}));
 const result=spawnSync('npm',['run','build'],{cwd:f.directory,encoding:'utf8',timeout:15000});
 expect(result.error).toBeUndefined();expect(result.status).not.toBe(0);expect(result.stderr).toContain('catalog_boundary');expect(result.stdout).not.toContain('UNREACHABLE');
 }finally{f.cleanup();}
});
function requirePackage(){return readFileSync('package.json','utf8');}
import {readFileSync} from 'node:fs';

test.each(["import {versionBackend as get} from './storage/version-registry.js';","export {versionBackend as get} from './storage/version-registry.js';","export * from './storage/version-registry.js';","import * as registry from './storage/version-registry.js';","void import('./storage/version-registry.js');","require('./storage/version-registry.js');","import {registerVersions} from './storage/version-registry.js';"] )('внутренний реестр не даёт обход: %s',code=>{
 const f=fixture();try{f.put('src/storage/version-registry.ts','export const versionBackend=1,registerVersions=1;');f.put('src/helper.ts',code);f.put('src/tools/a.ts',"import '../helper.js';");expect(checkCatalogBoundary(f.directory)).toHaveLength(1);}finally{f.cleanup();}
});
test('единственное исключение реестра — регистрация из открытия Storage',()=>{
 const f=fixture();try{f.put('src/storage/version-registry.ts','export const versionBackend=1,registerVersions=1;');f.put('src/storage/storage.ts',"import {registerVersions} from './version-registry.js';");f.put('src/storage/index.ts',"import './storage.js';");f.put('src/tools/a.ts',"import '../storage/index.js';");expect(checkCatalogBoundary(f.directory)).toEqual([]);
 f.put('src/storage/storage.ts',"import {registerVersions,versionBackend} from './version-registry.js';");expect(checkCatalogBoundary(f.directory)).toHaveLength(1);
 }finally{f.cleanup();}
});

test.each(['queue-registry.ts','queue-store.ts'])('очередь: инфраструктура %s недоступна через транзитивный импорт',module=>{
 const f=fixture();try{
 f.put('src/storage/'+module,'export const admin=1;');
 f.put('src/helper.ts',`export * from './storage/${module.replace('.ts','.js')}';`);
 f.put('src/core/context.ts',"import '../helper.js';");expect(checkCatalogBoundary(f.directory)).toHaveLength(1);
 }finally{f.cleanup();}
});
