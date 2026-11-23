import {expect,test} from 'vitest';
import {routeMessage} from '../src/core/message-router/routing.js';
import {directlyAddressesName} from '../src/core/message-router/name-address.js';
import {publicationDecision} from '../src/core/message-router/publication.js';
import type {IncomingMessage} from '../src/contracts/index.js';
export const incoming:IncomingMessage={kind:'message',chatId:'vk:a',userId:'vk:u',authorName:'',isGroupChat:true,isAdmin:false,isBot:false,text:'Пенек помоги с задачей',messageId:'1',isMentioned:false,isReplyToBot:false,timestamp:0,attachments:[]};
for(const mode of ['silent','normal','active'] as const)for(const isBot of [false,true,'unknown'] as const)test(`${mode} ${isBot}`,()=>{
 const result=routeMessage({message:{...incoming,isBot},settings:{enabled:true,responseMode:mode}});
 expect(result.kind).toBe(mode!=='silent'&&isBot===false?'ordinary':'silence');
 if(isBot==='unknown')expect(result.reason).toBe('sender_unknown');
});
test('личка active→normal; выключенный обычный путь молчит',()=>{
 expect(routeMessage({message:{...incoming,isGroupChat:false,text:'любой текст'},settings:{enabled:true,responseMode:'active'}})).toMatchObject({route:{mode:'normal',kind:'direct_message'}});
 expect(routeMessage({message:incoming,settings:{enabled:false,responseMode:'normal'}})).toMatchObject({reason:'disabled'});
 expect(routeMessage({message:{...incoming,isBot:undefined} as unknown as IncomingMessage,settings:{enabled:true,responseMode:'normal'}})).toMatchObject({reason:'invalid_input'});
});
for(const text of ['Пенек помоги с задачей','Помоги с задачей Пенёк','Подскажи пожалуйста Пенёк как это сделать','Как ты думаешь Пенек','Как дела Пенёк','ПЕНЁК!','Пенек, помоги!','Помоги! Пенек?'])test(text,()=>expect(directlyAddressesName(text)).toBe(true));
for(const text of ['Пенёк сегодня молчит','Мы обсуждали бота Пенек','Он сказал: “Пенёк помоги”','Иван помоги настроить Пенек','Пенёчек','суперпенек','Почему Пенёк молчит','Как ты думаешь почему Пенёк молчит'])test(text,()=>expect(directlyAddressesName(text)).toBe(false));
for(const kind of ['incomplete','refused','empty','rate_limit','tools_not_supported','deadline_exceeded','attempt_limit','error','failed','queue_full'])test('публикация '+kind,()=>{
 const route={kind:'name',mode:'normal',isGroupChat:true} as const;
 expect(publicationDecision(route,{enabled:true,responseMode:'normal'},{kind,partialText:'SECRET',message:'SECRET'})).toEqual({kind:'notice'});
 expect(publicationDecision({...route,mode:'active'},{enabled:true,responseMode:'active'},{kind})).toEqual({kind:'silence'});
});
for(const kind of ['cancelled','expired','interrupted','message_missing','UNKNOWN'])test('молчание '+kind,()=>expect(publicationDecision({kind:'name',mode:'normal',isGroupChat:true},{enabled:true,responseMode:'normal'},{kind})).toEqual({kind:'silence'}));

test.each([
 ['other',false,false,'reply_other'],
 ['other',true,false,'reply_other'],
 ['other',true,true,'mention'],
 ['unknown',true,true,'reply_unknown'],
 ['bot',false,false,'reply'],
] as const)('адресация reply %s с упоминанием %s и единственностью %s', (replyAddress,isMentioned,soleBotMention,reason)=>{
 const message={...incoming,replyAddress,isMentioned,soleBotMention,isReplyToBot:replyAddress==='bot'};
 expect(routeMessage({message,settings:{enabled:true,responseMode:'normal'}}).reason).toBe(reason);
});
