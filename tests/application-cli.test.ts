import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test, vi } from 'vitest';
import { initializePrompt, resolveApplicationChat } from '../src/app/setup.js';
import { loadPromptConfig } from '../src/config/application.js';
import { storageFixture } from './helpers/storage-fixture.js';

function child(args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  const processHandle = spawn(process.execPath, args, { env, cwd });
  const closed = once(processHandle, 'close');
  let output = '';
  processHandle.stdout.on('data', chunk => { output += String(chunk); });
  processHandle.stderr.on('data', chunk => { output += String(chunk); });
  return { processHandle, closed, output: () => output };
}

const modulePath = resolve('dist/app/cli.js');

test('локальные команды раскрытия и удаления обрабатывают только указанное поколение', async () => {
  const f=storageFixture();
  const env={DATABASE_PATH:f.path,BOT_OWNER_ID:'vk:73'};
  const chat='vk:2000000010';
  const other='vk:2000000011';
  const path=join(f.directory,'disclosure.json');
  try {
    await writeFile(path,JSON.stringify({provider:'OpenCode Go',dataPolicy:'history',storagePolicy:'fixture',
      detailsUrl:'https://example.test/details',detailsText:'Синтетические подробности',ownerContact:'Тестовый владелец',change:'material'}));
    const set=child([modulePath,'set-disclosure',path],env,f.directory);
    expect(await set.closed).toEqual([0,null]);
    expect(JSON.parse(set.output())).toEqual({version:1});
    const scope=await resolveApplicationChat({databasePath:f.path,ownerId:'vk:73'},chat,'new');
    const neighbor=await resolveApplicationChat({databasePath:f.path,ownerId:'vk:73'},other,'new');
    const initial=child([modulePath,'onboarding-status',chat],env,f.directory);
    expect(await initial.closed).toEqual([0,null]);
    expect(JSON.parse(initial.output())).toMatchObject({connection:{generation:scope.generation},publications:[]});
    const stale=child([modulePath,'delete-chat-data',chat,String(neighbor.generation)],env,f.directory);
    expect(await stale.closed).toEqual([1,null]);
    const remove=child([modulePath,'delete-chat-data',chat,String(scope.generation)],env,f.directory);
    expect(await remove.closed).toEqual([0,null]);
    const removed=child([modulePath,'onboarding-status',chat],env,f.directory);
    expect(await removed.closed).toEqual([0,null]);
    expect(JSON.parse(removed.output())).toEqual({connection:null,publications:[]});
    const intact=child([modulePath,'onboarding-status',other],env,f.directory);
    expect(await intact.closed).toEqual([0,null]);
    expect(JSON.parse(intact.output())).toMatchObject({connection:{generation:neighbor.generation}});
  } finally { f.cleanup(); }
});

test('точка входа отклоняет неполный конфиг безопасным кодом до сетевых вызовов', async () => {
  const fixture = storageFixture();
  try {
    const process = child([modulePath, 'start'], { VK_TOKEN: 'test-secret-never-printed' }, fixture.directory);
    expect(await process.closed).toEqual([1, null]);
    expect(process.output()).toContain('config_invalid');
    expect(process.output()).not.toContain('test-secret-never-printed');
  } finally { fixture.cleanup(); }
});

test.each(['SIGINT', 'SIGTERM'] as const)('в собранном процессе %s и повторный сигнал используют одну остановку', async signal => {
  const fixture = storageFixture();
  const env = {
    VK_TOKEN: 'test-vk', OPENCODE_API_KEY: 'test-opencode', LLM_MODEL: 'test-model', BOT_OWNER_ID: 'vk:73',
    VK_GROUP_ID: '314', DATABASE_PATH: fixture.path, MODEL_CONTEXT_TOKENS: '16000',
    MESSAGE_RETENTION_DAYS: '30', LLM_SESSION_SECRET: 'test-session',
  };
  const prompt = join(fixture.directory, 'prompt.txt');
  await writeFile(prompt, 'Синтетический текст.');
  expect(await initializePrompt(loadPromptConfig({ env, readFile: () => '' }), prompt)).toBeNull();
  const script = `
    import { runProcess } from ${JSON.stringify(modulePath)};
    const transport = {
      async run(listener, signal) {
        const connection = setInterval(() => {}, 100);
        try {
          await listener.onGap('startup');
          listener.onReady();
          await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
          await new Promise(resolve => setTimeout(resolve, 100));
        } finally {
          clearInterval(connection);
        }
      },
    };
    process.exitCode = await runProcess(['start'], { dependencies: { vk: { transport } } });
  `;
  const process = child(['--input-type=module', '-e', script], env, fixture.directory);
  try {
    await vi.waitFor(() => expect(process.output()).toContain('application_ready'), { timeout: 1800 });
    expect(process.processHandle.kill(signal)).toBe(true);
    expect(process.processHandle.kill(signal === 'SIGINT' ? 'SIGTERM' : 'SIGINT')).toBe(true);
    expect(await process.closed).toEqual([0, null]);
    expect(process.output().match(/application_stopped/g)).toHaveLength(1);
    expect(process.output()).not.toContain('test-session');
  } finally {
    process.processHandle.kill('SIGKILL');
    await process.closed;
    fixture.cleanup();
  }
});
