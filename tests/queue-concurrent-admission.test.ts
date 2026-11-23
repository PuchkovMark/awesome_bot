import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { openStorage } from '../src/storage/index';
import { tokenBudgetStore } from '../src/storage/token-budget-store';
import { queueBackend } from '../src/storage/queue-registry';
import { scopeFor } from './helpers/connection-scope';
import { storageFixture } from './helpers/storage-fixture';
async function contender(path: string, id: string, operation: 'queue' | 'budget' = 'queue') {
  const code = `
  const root=process.argv[2];const {openStorage}=await import(root+'/storage/index.js');
  const {lifecycleBackend}=await import(root+'/storage/lifecycle-store.js');
  const {queueBackend}=await import(root+'/storage/queue-registry.js');
  const {queueConfig}=await import(root+'/core/chat-queue/validation.js');
  const {tokenBudgetStore}=await import(root+'/storage/token-budget-store.js');
  const storage=await openStorage(process.argv[1]);const scope=lifecycleBackend(storage).current('vk:a');
  process.stdout.write('ready\\n');
  process.stdin.once('data',async()=>{try{
   const id=process.argv[3];
   const result=process.argv[4]==='budget'
    ? String(tokenBudgetStore(storage).reserve(scope,true,{key:id,purpose:'direct',input:1000,output:500},1000))
    : queueBackend(storage).admit('shared',scope,{chatId:'vk:a',messageId:id,userId:'vk:u',authorName:'',role:'user',text:'synthetic',timestamp:0},()=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,150);return true;},queueConfig({maxQueuedPerChat:1})).status;
   process.stdout.write(result+'\\n');
  }finally{await storage.close();}});
 `;
  const child = spawn(
    process.execPath,
    ['--input-type=module', '--eval', code, path, resolve('dist'), id, operation],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let text = '',
    errors = '';
  child.stderr.on('data', (chunk) => {
    errors += String(chunk);
  });
  const ready = new Promise<void>((yes, no) => {
    child.stdout.on('data', (chunk) => {
      text += String(chunk);
      if (text.includes('ready')) yes();
    });
    child.once('error', no);
    child.once('exit', (code) => {
      if (code !== 0) no(Error(errors));
    });
  });
  const done = new Promise<string>((yes, no) => {
    child.once('error', no);
    child.once('exit', (code) => {
      if (code !== 0) no(Error(errors));
      else yes(text.trim().split('\n').at(-1)!);
    });
  });
  await ready;
  return { child, done };
}
test.each([true, false])('два процесса пересекают постановки, дубль=%s', async (duplicate) => {
  const f = storageFixture(),
    storage = await openStorage(f.path);
  const processes: Awaited<ReturnType<typeof contender>>[] = [];
  try {
    const scope = scopeFor(storage, 'vk:a');
    queueBackend(storage).acquire('shared', 30000, 10000);
    processes.push(
      ...(await Promise.all([
        contender(f.path, 'first'),
        contender(f.path, duplicate ? 'first' : 'second'),
      ])),
    );
    for (const p of processes) p.child.stdin.end('go');
    expect((await Promise.all(processes.map((p) => p.done))).sort()).toEqual(
      duplicate ? ['duplicate', 'queued'] : ['queue_full', 'queued'],
    );
    expect(await storage.messages.list(scope, { limit: 10 })).toHaveLength(duplicate ? 1 : 2);
    expect(queueBackend(storage).depth('shared').depthQueued).toBe(1);
    queueBackend(storage).release('shared');
  } finally {
    for (const p of processes) p.child.kill();
    await storage.close();
    f.cleanup();
  }
});

test('два процесса конкурируют за остаток одного токен-бюджета', async () => {
  const fixture = storageFixture();
  const storage = await openStorage(fixture.path);
  const processes: Awaited<ReturnType<typeof contender>>[] = [];
  try {
    const scope = scopeFor(storage, 'vk:a');
    const store = tokenBudgetStore(storage);
    store.update(scope, true, { total: 1500 }, 1000);
    processes.push(
      ...(await Promise.all([
        contender(fixture.path, 'job:1:1', 'budget'),
        contender(fixture.path, 'job:2:1', 'budget'),
      ])),
    );
    for (const { child } of processes) child.stdin.end('go');
    expect((await Promise.all(processes.map(({ done }) => done))).sort()).toEqual([
      'false',
      'true',
    ]);
    expect(store.read(scope, true, 1000).total).toMatchObject({ reserved: 1500n, remaining: 0 });
  } finally {
    for (const { child } of processes) child.kill();
    await storage.close();
    fixture.cleanup();
  }
});
