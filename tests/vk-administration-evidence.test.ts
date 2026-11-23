import { expect, test, vi } from 'vitest';
import { createVkAdministrationEvidence } from '../src/channels/vk/administration-evidence';
import type { VkApiCall } from '../src/channels/vk/api';
import type { ConnectionScope } from '../src/contracts/index';

const peer=2000000001;
const scope={chatId:`vk:${peer}`,generation:1} as unknown as ConnectionScope;
const inviter={messageId:42,actorId:'vk:72',timestamp:10_000} as const;
const guard={isCurrent:()=>true};

test('снимок связывает приглашение сообщества и создателя с данными указанной беседы', async () => {
  let author=72, owner=71, joinDate=10, role:boolean|undefined=false;
  const request=vi.fn<VkApiCall>(async (method,args) => {
    if (method==='messages.getConversationsById') return {items:[{peer:{id:peer},chat_settings:{state:'in',owner_id:owner}}]};
    if (method==='messages.getConversationMembers') return {items:[{member_id:-17,is_admin:role,invited_by:72,join_date:joinDate},
      {member_id:71,is_owner:true},{member_id:72},{member_id:12,is_admin:true}]};
    expect(args).toEqual({peer_id:peer,conversation_message_ids:'42'});
    return {items:[{peer_id:peer,conversation_message_id:42,from_id:author,date:10,
      action:{type:'chat_invite_user',member_id:-17}}]};
  });
  const source=createVkAdministrationEvidence({request},17);
  const input={invite:inviter,admins:[]};
  expect(await source.observe(scope,input,guard)).toEqual({communityAdmin:false,observation:{confidence:'confirmed',bot:'present',
    creatorId:'vk:71',inviterId:'vk:72',members:{complete:false,ids:['vk:71','vk:72']}}});
  author=78;role=undefined;
  const contradictory=await source.observe(scope,input,guard);
  expect(contradictory.communityAdmin).toBe('unknown');
  expect(contradictory.observation.creatorId).toBe('vk:71');
  expect(contradictory.observation.inviterId).toBeUndefined();
  owner=73;joinDate=20;
  expect((await source.observe(scope,input,guard)).observation).toMatchObject({bot:'present',members:{complete:false}});
  const before=request.mock.calls.filter(([method])=>method==='messages.getByConversationMessageId').length;
  const mismatched=await source.observe(scope,input,guard);
  expect(mismatched.observation.creatorId).toBeUndefined();
  expect(mismatched.observation.inviterId).toBeUndefined();
  expect(request.mock.calls.filter(([method])=>method==='messages.getByConversationMessageId')).toHaveLength(before);
});

test('недоступный состав и смена области дают неопределённость, а приглашение без квитанции ничего не назначает', async () => {
  let current=true, deny=false;
  const request=vi.fn<VkApiCall>(async method => {
    if (method==='messages.getConversationsById') return {items:[{peer:{id:peer},chat_settings:{state:'in',owner_id:71}}]};
    if (method==='messages.getConversationMembers' && !deny) return {items:[
      {member_id:-17,is_admin:true,invited_by:72,join_date:10},{member_id:71,is_owner:true}]};
    throw new Error('Ошибка тестового VK');
  });
  const source=createVkAdministrationEvidence({request},17);
  expect(await source.observe(scope,{invite:inviter,admins:[]},guard)).toMatchObject({communityAdmin:true,
    observation:{creatorId:'vk:71'}});
  expect((await source.observe(scope,{invite:inviter,admins:[]},guard)).observation.inviterId).toBeUndefined();
  expect(await source.hasMember(scope,'vk:71',guard)).toBe(true);
  deny=true;
  expect(await source.observe(scope,{invite:undefined,admins:[]},guard)).toEqual({communityAdmin:'unknown',
    observation:{confidence:'unavailable',bot:'unknown'}});
  expect(await source.hasMember(scope,'vk:71',guard)).toBe(false);
  deny=false;current=false;
  expect(await source.hasMember(scope,'vk:71',{isCurrent:()=>current})).toBe(false);
  expect((await source.observe(scope,{invite:undefined,admins:[]},{isCurrent:()=>current})).observation.confidence).toBe('unavailable');
});
