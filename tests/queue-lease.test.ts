import { expect, test, vi } from 'vitest';
import { openStorage } from '../src/storage/index';
import { queueBackend } from '../src/storage/queue-registry';
import { createChatQueue, createLifecycleService } from '../src/core/index';
import { queueMessage } from './helpers/chat-queue';
import { storageFixture } from './helpers/storage-fixture';
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

test('начальная пауза защищена владением и предшествует выдаче старого задания VK', async () => {
  const fixture = storageFixture();
  const firstStorage = await openStorage(fixture.path);
  const secondStorage = await openStorage(fixture.path);
  const options = {
    ownerId: 'vk:73' as const,
    source: { async observe() { return { confidence: 'confirmed', bot: 'present' } as const; } },
  };
  const life = createLifecycleService({ ...options, storage: firstStorage });
  const first = queueBackend(firstStorage);
  const handled = vi.fn(async () => 'completed' as const);
  const second = createChatQueue({
    storage: secondStorage, handler: handled, tracing: { messageRetentionDays: 30 }, platform: 'vk',
  });
  try {
    const scope = (await life.verify('vk:1')).scope!;
    const admission = life.admissionScope('vk:1');
    const other = (await life.verify('other:1')).scope!;
    first.acquire('owner', 100_000, 10);
    const rejected = createChatQueue({
      storage: secondStorage, handler: handled, tracing: { messageRetentionDays: 30 }, platform: 'vk',
    });
    await expect(rejected.start()).rejects.toMatchObject({ code: 'owned' });
    expect(life.isAdmissionCurrent(admission)).toBe(true);
    const { queueConfig } = await import('../src/core/chat-queue/validation');
    expect(first.admit('owner', scope, queueMessage('vk:1', '1'), () => true, queueConfig()).status).toBe('queued');
    const neighbor = first.admit('owner', other, { ...queueMessage('other:1', '1'), userId: 'other:u' }, () => true, queueConfig());
    first.release('owner');
    await second.start();
    expect(() => life.current('vk:1')).toThrow('uncertain_connection');
    expect(life.current('other:1').generation).toBe(other.generation);
    expect(handled).not.toHaveBeenCalled();
    life.decide(life.owner('vk:1', 'vk:73'), 'continue');
    await vi.waitFor(() => expect(handled).toHaveBeenCalledOnce(), { timeout: 2200 });
    expect(neighbor.status).toBe('queued');
    if (neighbor.status === 'queued') expect(await firstStorage.queue.get(other, neighbor.jobId)).toMatchObject({ state: 'queued' });
  } finally {
    await second.stop();
    await firstStorage.close();
    await secondStorage.close();
    fixture.cleanup();
  }
});

test('истечение внутри транзакции откатывает её изменения',async()=>{
 const storage=await openStorage(':memory:');vi.useFakeTimers();vi.setSystemTime(1000);
 try{
 const q=queueBackend(storage);q.acquire('owner',100,10);
 expect(()=>q.transaction('owner',db=>{db.prepare('UPDATE queue_lease SET sequence=99').run();vi.setSystemTime(1100);})).toThrow('queue_lost_ownership');
 q.acquire('next',100,10);expect(q.transaction('next',db=>db.prepare('SELECT sequence FROM queue_lease').get())).toEqual({sequence:0});q.release('next');
 }finally{vi.useRealTimers();await storage.close();}
});
