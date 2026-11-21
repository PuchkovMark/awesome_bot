import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { storageFixture } from './helpers/storage-fixture.js';

test('ESM-выпуск открывает БД вне проекта без исходников', () => {
  const fixture = storageFixture();
  try {
    cpSync(resolve('dist'), join(fixture.directory, 'dist'), { recursive: true });
    writeFileSync(join(fixture.directory, 'package.json'), '{"type":"module"}');
    symlinkSync(resolve('node_modules'), join(fixture.directory, 'node_modules'), 'dir');
    expect(existsSync(join(fixture.directory, 'src'))).toBe(false);
    const moduleUrl = pathToFileURL(join(fixture.directory, 'dist/storage/index.js')).href;
    const coreUrl = pathToFileURL(join(fixture.directory, 'dist/core/index.js')).href;
    const code = `
      import { createLifecycleService } from ${JSON.stringify(coreUrl)};
      import { openStorage } from ${JSON.stringify(moduleUrl)};
      const storage = await openStorage(${JSON.stringify(fixture.path)});
      try {
        const life=createLifecycleService({storage,ownerId:'vk:owner',source:{async observe(){return {confidence:'confirmed',bot:'present'};}}});
        const scope=(await life.verify('vk:1')).scope;
        await storage.messages.append(scope,{chatId:'vk:1',userId:'vk:2',messageId:'1',authorName:'',role:'user',text:'кот',timestamp:0});
        const rows = await storage.messages.list(scope, {limit:1});
        if (rows.length !== 1 || rows[0].text !== 'кот') throw new Error('Incorrect journal');
        const next=life.decide(life.owner('vk:1','vk:owner'),'new');
        if(next.generation===scope.generation || (await storage.messages.list(next,{limit:1})).length)throw new Error('Incorrect reset');
        let rejected=false;try{await storage.messages.list(scope,{limit:1});}catch(e){rejected=e.code==='stale_scope';}
        if(!rejected)throw new Error('Old scope accepted');
      } finally { await storage.close(); }
      process.stdout.write('STORAGE_COMPLETED');
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', code], {
      cwd: fixture.directory, env: {}, encoding: 'utf8', timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('STORAGE_COMPLETED');
    expect(result.stderr).toBe('');
    expect(existsSync(fixture.path)).toBe(true);
    const inspection = new Database(fixture.path);
    try {
      expect(inspection.prepare("SELECT name FROM sqlite_schema WHERE name IN ('chat_participants','participant_profiles','profile_facts') ORDER BY name").all())
        .toEqual([{ name: 'chat_participants' }, { name: 'participant_profiles' }, { name: 'profile_facts' }]);
      expect(inspection.prepare('SELECT version FROM schema_migrations ORDER BY version').all())
        .toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }]);
      expect(inspection.pragma('foreign_key_check')).toEqual([]);
    } finally { inspection.close(); }
  } finally { fixture.cleanup(); }
});
