import { expect, test, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { queueBackend } from '../src/storage/queue-registry.js';
import { storageFixture } from './helpers/storage-fixture.js';
test('отдельные соединения: второй владелец, продление, истечение, старый маркер', async () => {
  const f = storageFixture(); const a = await openStorage(f.path), b = await openStorage(f.path);
  vi.useFakeTimers(); vi.setSystemTime(1000);
  try {
    const qa = queueBackend(a), qb = queueBackend(b);
    qa.acquire('a', 100, 10); expect(() => qb.acquire('b', 100, 10)).toThrow('queue_owned');
    vi.setSystemTime(1050); qa.renew('a', 100);
    vi.setSystemTime(1100); expect(() => qb.acquire('b', 100, 10)).toThrow('queue_owned');
    vi.setSystemTime(1150); qb.acquire('b', 100, 10);
    for (const op of [() => qa.renew('a',100), () => qa.release('a'), () => qa.transaction('a', () => 'bad')]) expect(op).toThrow('queue_lost_ownership');
    qb.release('b'); qa.acquire('c',100,10); qa.release('c');
  } finally { vi.useRealTimers(); await a.close(); await b.close(); f.cleanup(); }
});

test('истечение внутри транзакции откатывает её изменения',async()=>{
 const storage=await openStorage(':memory:');vi.useFakeTimers();vi.setSystemTime(1000);
 try{
 const q=queueBackend(storage);q.acquire('owner',100,10);
 expect(()=>q.transaction('owner',db=>{db.prepare('UPDATE queue_lease SET sequence=99').run();vi.setSystemTime(1100);})).toThrow('queue_lost_ownership');
 q.acquire('next',100,10);expect(q.transaction('next',db=>db.prepare('SELECT sequence FROM queue_lease').get())).toEqual({sequence:0});q.release('next');
 }finally{vi.useRealTimers();await storage.close();}
});
