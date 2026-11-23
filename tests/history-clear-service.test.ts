import Database from 'better-sqlite3';
import { expect, test, vi } from 'vitest';
import { createAuthorizationService } from '../src/core/authorization/service';
import { createHistoryClearService } from '../src/core/history-retention/service';
import { openStorage } from '../src/storage/index';
import { scopeFor } from './helpers/connection-scope';
import { storageFixture } from './helpers/storage-fixture';

const chat='vk:2000000001', ownerId='vk:1', first='vk:2', second='vk:3', outsider='vk:4';
const clear={kind:'request'} as const;
const active=()=>true;
function code(reply: string|null): string {
  expect(reply).toMatch(/\/подтвердить-очистку [a-f0-9]{32}$/u);
  return reply!.slice(-32);
}

test('№700 перед №500 сохраняет максимум; код связан с отправителем, каналом, правом и сроком', async () => {
  const files=storageFixture(), storage=await openStorage(files.path), db=new Database(files.path);
  const scope=scopeFor(storage,chat);
  await storage.chats.create(scope,{enabled:true,responseMode:'active',createdAt:1});
  const initial=Date.now();
  let now=initial;
  const authorization=await createAuthorizationService({config:{ownerId,reasonMaxLength:100,reasonRetentionDays:30},store:storage.authorization});
  const wakeMaintenance=vi.fn();
  const clearService=createHistoryClearService({storage,authorization,wakeMaintenance,now:()=>now});
  const grant=(userId:typeof first|typeof second)=>storage.authorization.transaction(scope,tx=>
    tx.grant({userId,basis:'explicit',grantedAt:initial,grantedBy:ownerId}));
  const insert=db.prepare(`INSERT INTO messages(id,chat_id,platform_message_id,user_id,author_name,role,text,timestamp)
    VALUES(?,?,?,?,?,'user','Синтетическая история',?)`);
  const fill=(start:number,end:number)=>db.transaction(()=>{
    for(let id=start;id<=end;id++)insert.run(id,chat,String(id),first,'',initial-id);
  })();
  try {
    await grant(first);await grant(second);
    const admin1=authorization.context({scope,userId:first});
    const admin2=authorization.context({scope,userId:second});
    const member=authorization.context({scope,userId:outsider});
    const owner=authorization.context({scope,userId:ownerId,kind:'owner'});
    fill(1,500);
    const firstReply=await clearService.handle(admin1,chat,'request-1',clear,active);
    expect(firstReply).toContain('Сообщений к очистке: 500');
    expect(firstReply).toContain('Переписка в VK сохранится');
    expect(await clearService.handle(member,chat,'member',clear,active)).toBeNull();
    fill(501,700);
    const secondReply=await clearService.handle(admin2,chat,'request-2',clear,active);
    expect(secondReply).toContain('Сообщений к очистке: 700');
    fill(701,701);
    expect(await clearService.handle(admin1,chat,'request-1',clear,active,true)).toBe(firstReply);
    expect(await clearService.handle(admin1,chat,'unseen',clear,active,true)).toBeNull();
    const confirmation1={kind:'confirm',code:code(firstReply)} as const;
    const confirmation2={kind:'confirm',code:code(secondReply)} as const;
    expect(await clearService.handle(admin1,chat,'fake',confirmation2,active)).toContain('недействителен');
    expect(await clearService.handle(admin2,'vk:3','wrong-origin',confirmation2,active)).toBeNull();
    expect(await clearService.handle(admin2,chat,'confirm-2',confirmation2,active)).toContain('подтверждена');
    expect(await clearService.handle(admin1,chat,'confirm-1',confirmation1,active)).toContain('подтверждена');
    expect(await clearService.handle(admin2,chat,'repeat',confirmation2,active)).toContain('уже использован');
    expect(wakeMaintenance).toHaveBeenCalledTimes(2);
    expect(db.prepare('SELECT cleared_through FROM history_retention_boundaries').get()).toEqual({cleared_through:700});
    expect(db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({n:701});
    expect((await storage.messages.list(scope,{limit:750})).map(row=>row.id)).toEqual([701]);

    const invalidated=code(await clearService.handle(admin1,chat,'before-loss',clear,active));
    await storage.authorization.transaction(scope,tx=>tx.remove(first,false));
    await grant(first);
    expect(await clearService.handle(admin1,chat,'after-grant',{kind:'confirm',code:invalidated},active)).toContain('недействителен');
    await storage.chats.update(scope,{enabled:false});
    const privateReply=await clearService.handle(owner,ownerId,'private',{kind:'request',target:scope},active);
    expect(privateReply).toContain('Сообщений к очистке: 1');
    now=initial+300_000;
    expect(await clearService.handle(owner,ownerId,'late',{kind:'confirm',code:code(privateReply)},active)).toContain('недействителен');
    expect(await storage.messages.get(scope,701)).not.toBeNull();
  } finally { authorization.dispose();await storage.close();db.close();files.cleanup(); }
});
