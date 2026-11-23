import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { createLifecycleService } from '../src/core/index';
import { disclosureStore, type DisclosureInput } from '../src/storage/chat-disclosure-store';
import { openStorage } from '../src/storage/index';
import { migrate } from '../src/storage/migrate';
import { migrations } from '../src/storage/migrations/index';
import { storageFixture } from './helpers/storage-fixture';

const initial = {
  provider: 'OpenCode Go', dataPolicy: 'history', storagePolicy: 'old',
  detailsText: 'Синтетические условия первой версии.',
  detailsUrl: 'https://example.test/details/1', ownerContact: 'Тестовый контакт', change: 'material',
} satisfies DisclosureInput;

test('состояние и операция отправки переживают перезапуск на обновлённой БД', async () => {
  const fixture = storageFixture();
  const old = new Database(fixture.path);
  try {
    migrate(old,migrations.slice(0,13));
    old.exec("INSERT INTO chat_connections(chat_id,generation,revision,state) VALUES ('vk:old',1,0,'active')");
    old.exec('UPDATE lifecycle_clock SET value=1');
    old.exec("INSERT INTO chats(chat_id,response_mode,timezone,enabled,created_at) VALUES ('vk:old','silent','UTC',0,0)");
  } finally { old.close(); }
  let storage = await openStorage(fixture.path);
  const lifecycle = () => createLifecycleService({storage, ownerId:'vk:owner', source:{async observe(){return {confidence:'confirmed',bot:'present'};}}});
  try {
    const first = lifecycle().current('vk:old');
    const store = disclosureStore(storage);
    expect(await storage.chats.get(first)).toMatchObject({timezone:'UTC',responseMode:'silent',enabled:false});
    expect(store.gate(first)).toEqual({journal:false,version:null,provider:null});
    const version = store.register(initial, 1);
    const intro = store.ensure(first,'introduction',version);
    expect(store.ensure(first,'introduction',version).id).toBe(intro.id);
    const sending = store.claim(first,intro.id,'Синтетическое вступление',10)!;
    expect(store.claim(first,intro.id,'Повтор',11)).toBeNull();
    await storage.close();
    storage = await openStorage(fixture.path);
    const next = lifecycle().current('vk:old');
    const reopened = disclosureStore(storage);
    reopened.recover(next);
    expect(reopened.publications(next)).toMatchObject([{state:'unknown',sendId:sending.sendId}]);
    expect(reopened.claim(next,intro.id,'Другой текст',12)).toBeNull();
    expect(reopened.claim(next,intro.id,'Другой текст',15,5)).toBeNull();
    const replay = reopened.claim(next,intro.id,'Другой текст',12,5)!;
    expect(replay).toMatchObject({sendId:sending.sendId,text:sending.text,attempt:2,replayUntil:15});
    expect(reopened.finish(next,replay,'unknown',13,'unconfirmed',null)).toBe(true);
    expect(reopened.claim(next,intro.id,'Другой текст',14,5)).toBeNull();
    expect(reopened.confirm(next,intro.id,'17',15)).toBe(true);
    expect(reopened.gate(next)).toEqual({journal:true,version,provider:'OpenCode Go'});
  } finally { await storage.close(); fixture.cleanup(); }
});

test('версии изолированы, диагностика считает поколения и очистка снимает связи беседы', async () => {
  const storage = await openStorage(':memory:');
  let present = true;
  const lifecycle = createLifecycleService({storage,ownerId:'vk:owner',source:{async observe(){return {confidence:'confirmed',bot:present?'present':'absent'};}}});
  try {
    const main = (await lifecycle.verify('vk:main')).scope!;
    const other = (await lifecycle.verify('vk:other')).scope!;
    const store = disclosureStore(storage);
    const first = store.register(initial,1);
    expect(store.register(initial,2)).toBe(first);
    const intro = store.ensure(main,'introduction',first);
    const attempt = store.claim(main,intro.id,'Вступление',2)!;
    expect(store.finish(main,attempt,'delivered',3,null,'6')).toBe(true);
    const owner = store.ensure(main,'owner',first);
    store.wait(main,owner.id,'owner_closed');
    store.cancel(main,owner.id,'rights');
    expect(store.claim(main,owner.id,'Уведомление',4)).toBeNull();
    expect(store.diagnostics()).toMatchObject([{kind:'introduction',connections:1},{kind:'owner',state:'cancelled',connections:1}]);
    store.register({...initial,change:'editorial',detailsUrl:'https://example.test/details/2'},5);
    expect(store.version(first)?.detailsText).toBe(initial.detailsText);
    expect(store.gate(main)).toMatchObject({journal:true,version:first});
    expect(() => store.register({...initial,change:'editorial',dataPolicy:'new data'},6)).toThrow('invalid_input');
    store.register({...initial,dataPolicy:'more'},7);
    expect(store.gate(main)).toMatchObject({journal:true,version:null});
    const last = store.register({...initial,dataPolicy:'more',storagePolicy:'new'},8);
    expect(store.gate(main)).toMatchObject({journal:false,version:null});
    const update = store.ensure(main,'update',last);
    const editorial = store.register({...initial,dataPolicy:'more',storagePolicy:'new',change:'editorial',
      detailsText:'Исправлена опечатка.'},9);
    expect(store.ensure(main,'update',editorial).id).toBe(update.id);
    const updateAttempt = store.claim(main,update.id,'Новое раскрытие',9)!;
    store.finish(main,updateAttempt,'delivered',10,null,'8');
    expect(store.gate(main)).toMatchObject({journal:true,version:last});
    expect(store.gate(other)).toMatchObject({journal:false,version:null});
    store.ensure(other,'introduction',last);
    present = false;
    await lifecycle.verify(main.chatId);
    expect(() => store.publications(main)).toThrow('stale_scope');
    expect(store.publications(other)).toHaveLength(1);
    expect(store.latest()?.version).toBe(editorial);
    present = true;
    const revived = (await lifecycle.verify(main.chatId)).scope!;
    expect(store.publications(revived)).toEqual([]);
  } finally { await storage.close(); }
});
