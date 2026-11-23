import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

test('собранное ядро вызывает подмену вне исходников без загрузки HTTP-клиента', () => {
  const directory = mkdtempSync(join(tmpdir(), 'awesome-agent-dist-'));
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
      const {createAgentLoop} = await import('./dist/core/index.js');
      let calls = 0;
      const loop = createAgentLoop({async complete(request) {
        calls++;
        if(request.tools || request.messages[0].text !== 'Привет') throw Error('Request');
        return {kind:'complete',text:' Ответ ',usage:{input:0,output:2}};
      }});
      if(calls || before !== JSON.stringify(process.env)) throw Error('Side effect');
      globalThis.setTimeout = timer;
      const result = await loop.run({system:'',messages:[{role:'user',text:'Привет'}],maxOutputTokens:1,sessionId:'opaque'});
      if(result.kind !== 'complete' || result.text !== ' Ответ ' || result.summary.steps !== 1 || result.summary.attempts !== 1) throw Error('Result');
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
