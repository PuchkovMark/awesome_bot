import {openStorage} from '../../src/storage/index.js';
import {scopeFor} from './connection-scope.js';
import {catalogAdministration} from '../../src/storage/catalog-admin.js';
import type {CapabilitySnapshot} from '../../src/contracts/capabilities.js';
import {createContextBuilder} from '../../src/core/context/index.js';
export function contextCapabilities(chatId:`${string}:${string}`):CapabilitySnapshot {
 return {context:{chatId},observedAt:0,support:{send:'supported',typing:'unknown',reply:'supported',getUserName:'unknown',adminInfo:'unknown',membershipEvents:'unknown',directMessage:'unknown'},maxMessageLength:'unknown',textFormats:['plain']};
}
export async function contextFixture(chatId:`${string}:${string}`='vk:ctx'){
 const storage=await openStorage(':memory:'),scope=scopeFor(storage,chatId);
 await storage.chats.create(scope,{enabled:true,responseMode:'normal',createdAt:0,timezone:'UTC'});
 const admin=catalogAdministration(storage);const version=await admin.append({kind:'system_prompt',key:'base',text:'Общие правила.',createdAt:0,expectedHead:null});if(version.status!=='created'||version.value.ref.area!=='global')throw Error();
 await admin.selectSystemPrompt(version.value.ref,null);
 const options={messages:storage.contextMessages,state:storage.contextState,config:{modelContextTokens:16000},capabilities:async()=>contextCapabilities(scope.chatId),sessionId:()=> 'session',now:()=>0};
 const builder=createContextBuilder(options);
 const put=async(id:string,text:string,extra:object={})=>storage.messages.append(scope,{chatId:scope.chatId,messageId:id,userId:`${chatId.split(':')[0]}:u`,authorName:'Имя',role:'user',text,timestamp:100,...extra});
 const work=(messageId:number,group=true)=>({scope,messageId,route:{kind:'mention' as const,mode:'normal' as const,isGroupChat:group},signal:new AbortController().signal,isCurrent:()=>true});
 return {storage,scope,admin,version:version.value,builder,options,put,work};
}
