import { expect, test, vi } from 'vitest';
import { createChatOnboarding } from '../src/core/chat-onboarding/service';
import type { IntroductionPort } from '../src/core/chat-onboarding/ports';
import { createLifecycleService } from '../src/core/index';
import { disclosureStore } from '../src/storage/chat-disclosure-store';
import { openStorage } from '../src/storage/index';

test('запрет отправки даёт одно предупреждение владельцу, а неизвестная доставка вступления сохраняет паузу', async () => {
  const storage=await openStorage(':memory:');
  const stop=new AbortController();
  const lifecycle=createLifecycleService({storage,ownerId:'vk:73',source:{async observe(){return {bot:'present',confidence:'confirmed'};}}});
  const chat='vk:2000000010';
  const store=disclosureStore(storage);
  const scope=(await lifecycle.verify(chat)).scope!;
  store.register({provider:'OpenCode Go',dataPolicy:'history',storagePolicy:'one',detailsText:'Подробности',
    detailsUrl:'https://example.test/details',ownerContact:'Тестовый контакт',change:'material'},1);
  let writing=false;
  const publish=vi.fn<IntroductionPort['publish']>(async (_scope,target)=> target==='owner'
    ? {kind:'delivered',receipt:'7'} : {kind:'unknown'});
  const rightCheck=vi.fn<IntroductionPort['writing']>(async (_scope,target)=>target==='owner'||writing ? 'allowed' : 'denied');
  const service=createChatOnboarding({storage,lifecycle,groups:()=>[chat],provider:'OpenCode Go',describeRights:()=> 'Тестовые права',signal:stop.signal,intervalMs:5,
    port:{writing:rightCheck,publish,async hasAdministration(){return false;},async confirm(){return false;}}});
  const running=service.run();
  try {
    await vi.waitFor(()=>expect(store.publications(scope).find(row=>row.kind==='owner')?.state).toBe('delivered'));
    await vi.waitFor(()=>expect(rightCheck.mock.calls.length).toBeGreaterThan(6));
    expect(publish.mock.calls.map(([,target])=>target)).toEqual(['owner']);
    writing=true;
    await vi.waitFor(()=>expect(store.publications(scope).find(row=>row.kind==='introduction')?.state).toBe('unknown'));
    const checks=rightCheck.mock.calls.length;
    await vi.waitFor(()=>expect(rightCheck.mock.calls.length).toBeGreaterThan(checks+1));
    expect(publish.mock.calls.map(([,target])=>target)).toEqual(['owner','chat']);
    expect(service.capture(scope)()).toEqual({journal:false,respond:false,version:null});
  } finally { stop.abort();await running;await storage.close(); }
});
