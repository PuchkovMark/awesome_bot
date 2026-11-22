import {mkdirSync,writeFileSync,symlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {expect,test} from 'vitest';
import {checkContextBoundary} from '../scripts/check-context-boundary.mjs';
import {storageFixture} from './helpers/storage-fixture.js';
for(const target of ['messages','storage','index','scoped-storage','notice-store','trace-store'])test('нет обхода полного журнала через '+target,()=>{
 const f=storageFixture();const put=(p:string,s:string)=>{mkdirSync(join(f.directory,p,'..'),{recursive:true});writeFileSync(join(f.directory,p),s);};
 try{symlinkSync(resolve('node_modules'),join(f.directory,'node_modules'),'dir');put('tsconfig.json',JSON.stringify({compilerOptions:{module:'NodeNext',moduleResolution:'NodeNext'},include:['src/**/*.ts']}));put('src/core/context.ts',"export * from '../bridge.js';");put('src/bridge.ts',`export * from './storage/${target}.js';`);put('src/storage/'+target+'.ts','export const hidden=1;');expect(checkContextBoundary(f.directory)).toHaveLength(1);
 put('src/bridge.ts',"export type {ContextMessageReader} from './storage/context-types.js';");put('src/storage/context-types.ts','export interface ContextMessageReader {}');expect(checkContextBoundary(f.directory)).toEqual([]);
 put('src/storage/context-types.ts',"export * from './messages.js';");expect(checkContextBoundary(f.directory)).toHaveLength(1);
 }finally{f.cleanup();}
});
test('переименование Storage при реэкспорте не превращает его в разрешённый тип',()=>{
 const f=storageFixture();const put=(p:string,s:string)=>{mkdirSync(join(f.directory,p,'..'),{recursive:true});writeFileSync(join(f.directory,p),s);};
 try{
 symlinkSync(resolve('node_modules'),join(f.directory,'node_modules'),'dir');put('tsconfig.json',JSON.stringify({compilerOptions:{module:'NodeNext',moduleResolution:'NodeNext'},include:['src/**/*.ts']}));
 put('src/core/context.ts',"export type {StoredMessage} from '../storage/context-types.js';");put('src/storage/types.ts','export interface Storage { messages:unknown }');
 put('src/storage/context-types.ts',"export type {Storage as StoredMessage} from './types.js';");expect(checkContextBoundary(f.directory)).toHaveLength(1);
 }finally{f.cleanup();}
});
test('inline import внутри типа разрешённого фасада также запрещён',()=>{
 const f=storageFixture();const put=(p:string,s:string)=>{mkdirSync(join(f.directory,p,'..'),{recursive:true});writeFileSync(join(f.directory,p),s);};
 try{
 symlinkSync(resolve('node_modules'),join(f.directory,'node_modules'),'dir');put('tsconfig.json',JSON.stringify({compilerOptions:{module:'NodeNext',moduleResolution:'NodeNext'},include:['src/**/*.ts']}));
 put('src/core/context.ts',"export type {ContextMessageReader} from '../storage/context-types.js';");put('src/storage/storage.ts','export function openStorage(){}');
 put('src/storage/context-types.ts',"export interface ContextMessageReader { get():typeof import('./storage.js') }");expect(checkContextBoundary(f.directory)).toHaveLength(1);
 }finally{f.cleanup();}
});
