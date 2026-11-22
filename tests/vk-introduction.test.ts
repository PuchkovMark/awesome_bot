import { expect, test, vi } from 'vitest';
import { createVkIntroduction } from '../src/channels/vk/introduction.js';
import { createVkOutbound } from '../src/channels/vk/outbound.js';
import type { VkApiCall } from '../src/channels/vk/api.js';
import type { ConnectionScope } from '../src/contracts/index.js';

test('служебная публикация повторяет сохранённый ключ, сверяет запись VK и ограничивает адресата', async () => {
  const chat = 'vk:2000000010';
  const scope = {chatId:chat,generation:1} as unknown as ConnectionScope;
  const guard = {signal:new AbortController().signal,isCurrent:()=>true};
  let ownerEnabled=false;
  const posted = new Map<number,{peer_id:number;from_id:number;conversation_message_id:number;text:string;date:number}>();
  let loseReceipt=true;
  const request = vi.fn<VkApiCall>(async (method,args) => {
    if(method==='messages.isMessagesFromGroupAllowed')return {is_allowed:ownerEnabled?1:0};
    if(method==='messages.getConversationsById')return {items:[{peer:{id:Number(args.peer_ids)},chat_settings:{state:'in'},can_write:{allowed:true}}]};
    if(method==='messages.getConversationMembers')return {items:[{member_id:-17,is_admin:false}]};
    if(method==='messages.send'){
      const id=Number(args.random_id);
      const message=posted.get(id)??{peer_id:Number(args.peer_ids),from_id:-17,conversation_message_id:posted.size+1,text:String(args.message),date:10};
      posted.set(id,message);
      if(loseReceipt){loseReceipt=false;throw new Error('ambiguous');}
      return [message];
    }
    if(method==='messages.getByConversationMessageId')return {items:[...posted.values()].filter(row=>row.peer_id===Number(args.peer_id)&&row.conversation_message_id===Number(args.conversation_message_ids))};
    throw new Error('unexpected request');
  });
  const api={request};
  const port=createVkIntroduction({owner:'vk:73',groupId:17,api,outbound:createVkOutbound({api,groupId:17,wait:async()=>{}})});
  expect(await port.writing(scope,'chat',guard)).toBe('allowed');
  expect(await port.hasAdministration(scope,guard)).toBe(false);
  expect(await port.writing(scope,'owner',guard)).toBe('denied');
  ownerEnabled=true;
  expect(await port.writing(scope,'owner',guard)).toBe('allowed');
  expect(await port.publish(scope,'chat','Вступление',543,guard)).toEqual({kind:'unknown'});
  expect(await port.publish(scope,'chat','Вступление',543,guard)).toEqual({kind:'delivered',receipt:'1'});
  expect(posted.size).toBe(1);
  expect(await port.confirm(scope,'Вступление','1',10000,guard)).toBe(true);
  expect(await port.confirm(scope,'Вступление','1',11000,guard)).toBe(false);
  expect(await port.confirm(scope,'Иное сообщение','1',10000,guard)).toBe(false);
  expect(await port.publish(scope,'owner','Оповещение',544,guard)).toEqual({kind:'delivered',receipt:'2'});
  expect(posted.get(544)?.peer_id).toBe(73);
  expect(await port.publish({chatId:'vk:13',generation:1} as unknown as ConnectionScope,'owner','Лишнее',545,guard)).toEqual({kind:'failed'});
});
