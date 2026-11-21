import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {expect,test} from 'vitest';
import {openStorage} from '../src/storage/index.js';
import {scopeFor} from './helpers/connection-scope.js';
import {storageFixture} from './helpers/storage-fixture.js';
import {queueMessage} from './helpers/chat-queue.js';
async function contender(path:string,id:number){
 const code=`const root=process.argv[2];const {openStorage}=await import(root+'/storage/index.js');const {lifecycleBackend}=await import(root+'/storage/lifecycle-store.js');const {noticeBackend}=await import(root+'/storage/notice-store.js');const s=await openStorage(process.argv[1]);const scope=lifecycleBackend(s).current('vk:a');process.stdout.write('ready\\n');process.stdin.once('data',async()=>{try{const p=noticeBackend(s).reserve(scope,Number(process.argv[3]),{kind:'name',mode:'normal',isGroupChat:true},100,0);process.stdout.write(p?'won\\n':'denied\\n');}finally{await s.close();}});`;
 const child=spawn(process.execPath,['--input-type=module','--eval',code,path,resolve('dist'),String(id)],{stdio:['pipe','pipe','pipe']});let output='',errors='';child.stderr.on('data',x=>{errors+=String(x);});
 const done=new Promise<string>((yes,no)=>{child.once('error',no);child.once('exit',code=>code===0?yes(output.trim().split('\n').at(-1)!):no(Error(errors)));});
 await new Promise<void>((yes,no)=>{child.stdout.on('data',x=>{output+=String(x);if(output.includes('ready'))yes();});child.once('error',no);child.once('exit',code=>{if(code!==0)no(Error(errors));});});return {child,done};
}
test('два процесса состязаются за один период: только одно разрешение',async()=>{
 const f=storageFixture(),s=await openStorage(f.path),children:Awaited<ReturnType<typeof contender>>[]=[];
 try{const scope=scopeFor(s,'vk:a');await s.chats.create(scope,{responseMode:'normal',enabled:true,createdAt:0});const m=await s.messages.append(scope,queueMessage('vk:a','1'));
 children.push(...await Promise.all([contender(f.path,m.id),contender(f.path,m.id)]));for(const p of children)p.child.stdin.end('go');expect((await Promise.all(children.map(p=>p.done))).sort()).toEqual(['denied','won']);
 }finally{for(const p of children)p.child.kill();await s.close();f.cleanup();}
});
