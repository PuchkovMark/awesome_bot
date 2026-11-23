import ts from 'typescript';
import {resolve} from 'node:path';
import {expect,test} from 'vitest';

test('все публичные запросные методы требуют обязательную область; alias и вложенный chatId не обходят проверку',()=>{
 const path=resolve('src/storage/boundary-fixture.ts');
 const fixture=`import type {ConnectionScope} from '../contracts/lifecycle';
 type OldId=string;
 export interface Bare { get(renamed:OldId):Promise<void> }
 export interface Optional { get(scope?:ConnectionScope):Promise<void> }
 export interface Nested { get(target:{chatId:string}):Promise<void> }
 export interface Any { get(target:any):Promise<void> }
 export interface Alias { get(scope:ConnectionScope):Promise<void> }
 export interface BadInfra { close(chatId:OldId):void; authorization:{pruneReasons(chatId:OldId):void} }
 `;
 const host=ts.createCompilerHost({});const original=host.getSourceFile.bind(host);
 host.getSourceFile=(p,version,...args)=>p===path?ts.createSourceFile(p,fixture,version,true):original(p,version,...args);
 const program=ts.createProgram([resolve('src/storage/types.ts'),path],{target:ts.ScriptTarget.ES2024,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,strict:true,skipLibCheck:true},host);
 const checker=program.getTypeChecker();
 const scopeFile=program.getSourceFile(resolve('src/contracts/lifecycle.ts'))!;
 const scopeSymbol=checker.getExportsOfModule(checker.getSymbolAtLocation(scopeFile)!).find(s=>s.name==='ConnectionScope')!;
 const scopeType=checker.getDeclaredTypeOfSymbol(scopeSymbol);
 function examine(file:string,name:string,root=name) {
  const sf=program.getSourceFile(file)!;const symbol=checker.getExportsOfModule(checker.getSymbolAtLocation(sf)!).find(s=>s.name===name)!;
  const seen=new Set<ts.Type>(),failures:string[]=[];
  function visit(type:ts.Type,path:string) {
   if(seen.has(type))return;seen.add(type);
   for(const property of type.getProperties()){
    const next=path+'.'+property.name;const target=checker.getTypeOfSymbolAtLocation(property,property.valueDeclaration??property.declarations![0]!);
    const signatures=target.getCallSignatures();
    if(!signatures.length){visit(target,next);continue;}
    if(next==='Storage.close'||next==='Storage.authorization.pruneReasons'){
     for(const signature of signatures){
      const count=next==='Storage.close'?0:2;
      if(signature.parameters.length!==count||signature.parameters.some(p=>{const d=p.valueDeclaration!;const t=checker.getTypeOfSymbolAtLocation(p,d);return !(t.flags&ts.TypeFlags.Number)||!!(ts.isParameter(d)&&(d.questionToken||d.initializer||d.dotDotDotToken));}))failures.push(next);
     }
     continue;
    }
    for(const signature of signatures){const param=signature.parameters[0];
     if(!param){failures.push(next);continue;}
     const decl=param.valueDeclaration!;const t=checker.getTypeOfSymbolAtLocation(param,decl);
     if((param.flags&ts.SymbolFlags.Optional)||(ts.isParameter(decl)&&decl.questionToken)|| (t.flags&(ts.TypeFlags.Any|ts.TypeFlags.Unknown)) || !checker.isTypeAssignableTo(t,scopeType)||!checker.isTypeAssignableTo(scopeType,t))failures.push(next);
    }
   }
  }
  visit(checker.getDeclaredTypeOfSymbol(symbol),root);return failures;
 }
 expect(examine(resolve('src/storage/types.ts'),'Storage')).toEqual([]);
 for(const name of ['Bare','Optional','Nested','Any'])expect(examine(path,name)).toEqual([name+'.get']);
 expect(examine(path,'Alias')).toEqual([]);
 expect(examine(path,'BadInfra','Storage')).toEqual(['Storage.close','Storage.authorization.pruneReasons']);
});
