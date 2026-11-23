import {mkdirSync,writeFileSync,symlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {expect,test} from 'vitest';
import {checkTraceBoundary} from '../scripts/check-trace-boundary.mjs';
import {storageFixture} from './helpers/storage-fixture';
for(const form of ["export * from './storage/trace-store';","export type {Hidden} from './storage/trace-store';","export type Hidden=typeof import('./storage/trace-store');","export const load=()=>import('./storage/trace-store');"])test('метрики не используют backend через '+form,()=>{
 const f=storageFixture();const put=(p:string,t:string)=>{mkdirSync(join(f.directory,p,'..'),{recursive:true});writeFileSync(join(f.directory,p),t);};try{
 symlinkSync(resolve('node_modules'),join(f.directory,'node_modules'),'dir');put('tsconfig.json',JSON.stringify({compilerOptions:{module:'ESNext',moduleResolution:'Bundler'},include:['src/**/*.ts']}));put('src/core/response-tracing/metrics.ts',"export * from '../../bridge';");put('src/bridge.ts',form);put('src/storage/trace-store.ts','export interface Hidden{}');expect(checkTraceBoundary(f.directory)).toEqual(['src/core/response-tracing/metrics.ts: trace_boundary: forbidden_access']);put('src/bridge.ts','export const count=1;');expect(checkTraceBoundary(f.directory)).toEqual([]);
 }finally{f.cleanup();}
});
