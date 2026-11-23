import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

test('dist-клиент самостоятелен: импорт и создание без побочных эффектов, вызов с подменой', () => {
  const directory = mkdtempSync(join(tmpdir(), 'awesome-llm-dist-'));
  try {
    cpSync('dist/llm', join(directory, 'llm'), { recursive: true });
    writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
    const code = `
      const timer = globalThis.setTimeout;
      globalThis.setTimeout = () => { throw Error('Unexpected timer'); };
      globalThis.fetch = () => { throw Error('Unexpected network'); };
      const before = JSON.stringify(process.env);
      const {createLlmClient,createLlmSessionId} = await import('./llm/index.js');
      const config = {provider:'opencode', apiKey:'synthetic', model:'deepseek-v4.1-flash'};
      createLlmClient(config);
      const sessionId = createLlmSessionId('synthetic-secret')({chatId:'vk:fixture',generation:1});
      let calls = 0;
      const client = createLlmClient(config, {fetch: async (url, init) => {
        calls++;
        if(url !== 'https://opencode.ai/inference/go/openai/v1/chat/completions' ||
          init.headers['x-opencode-session'] !== sessionId || init.redirect !== 'error') throw Error('Protocol');
        return Response.json({choices:[{finish_reason:'stop', message:{role:'assistant', content:'Ответ'}}]});
      }});
      if(calls !== 0 || before !== JSON.stringify(process.env)) throw Error('Creation side effect');
      globalThis.setTimeout = timer;
      const result = await client.complete({system:'',messages:[{role:'user',text:'Привет'}],maxOutputTokens:1,sessionId});
      if(result.kind !== 'complete' || result.text !== 'Ответ' || calls !== 1) throw Error('Call');
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
    expect(readdirSync(directory).sort()).toEqual(['llm', 'package.json']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
