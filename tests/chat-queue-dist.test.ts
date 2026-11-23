import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

test('создание очереди вне исходников не запускает таймеры, БД и сеть', () => {
  const directory = mkdtempSync(join(tmpdir(), 'awesome-queue-dist-'));
  try {
    cpSync('dist', join(directory, 'dist'), { recursive: true });
    symlinkSync(resolve('node_modules'), join(directory, 'node_modules'), 'dir');
    writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
    const code = `
      const {registerHooks} = await import('node:module');
      registerHooks({resolve(specifier, context, next) {
        if(specifier.includes('/llm/') || specifier === 'better-sqlite3') throw Error('Infrastructure loaded');
        return next(specifier, context);
      }});
      const timer = globalThis.setTimeout;
      globalThis.setTimeout = () => { throw Error('Timer during import/creation'); };
      globalThis.fetch = () => { throw Error('Unexpected network'); };
      const before = JSON.stringify(process.env);
      await import('./dist/core/index.js');
      const {createChatQueue} = await import('./dist/core/index.js');
      const {registerQueue} = await import('./dist/storage/queue-registry.js');
      const storage = {messages:{async get(){throw Error('Unexpected read');}}};
      registerQueue(storage,{});
      const {registerTraces}=await import('./dist/storage/trace-store.js');
      registerTraces(storage,{configure(){},observe(){}});
      const queue = createChatQueue({tracing:{messageRetentionDays:30},storage,handler:async()=>{throw Error('Unexpected handler');}});
      if(before !== JSON.stringify(process.env)) throw Error('Side effect');
      globalThis.setTimeout=timer;
      await queue.stop();
      process.stdout.write('OK');
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', code], {
      cwd: directory,
      env: {},
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('OK');
    expect(result.stderr).toBe('');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
