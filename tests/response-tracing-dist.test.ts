import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
test('ESM вне исходников создаёт и читает трассировку реальной очереди', () => {
  const d = mkdtempSync(join(tmpdir(), 'trace-dist-'));
  try {
    cpSync('dist', join(d, 'dist'), { recursive: true });
    symlinkSync(resolve('node_modules'), join(d, 'node_modules'), 'dir');
    writeFileSync(join(d, 'package.json'), '{"type":"module"}');
    const r = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
 const {openStorage}=await import('./dist/storage/index.js');const {createChatQueue}=await import('./dist/core/index.js');const {lifecycleBackend}=await import('./dist/storage/lifecycle-store.js');
 const s=await openStorage(':memory:');const b=lifecycleBackend(s);const scope=b.apply(b.begin('vk:a'),{confidence:'confirmed',bot:'present'}).scope;
 const q=createChatQueue({storage:s,tracing:{messageRetentionDays:30},handler:async()=> 'completed'});await q.start();const a=await q.admit(scope,{chatId:'vk:a',messageId:'m',userId:'vk:u',authorName:'',role:'user',text:'SECRET',timestamp:0},()=>true);
 for(let i=0;i<100;i++){if((await s.queue.get(scope,a.jobId)).state==='terminal')break;await new Promise(r=>setTimeout(r,1));}const trace=await s.traces.get(scope,a.jobId);if(trace?.outcome!=='completed'||JSON.stringify(trace).includes('SECRET'))throw Error('trace failed');await q.stop();await s.close();process.stdout.write('OK');
 `,
      ],
      { cwd: d, env: {}, encoding: 'utf8', timeout: 10000 },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('OK');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
