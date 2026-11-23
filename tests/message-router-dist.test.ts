import { spawnSync } from 'node:child_process';
import { cpSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { storageFixture } from './helpers/storage-fixture';
test('ESM вне исходников импортируется без БД, таймеров и сети', () => {
  const f = storageFixture();
  try {
    cpSync('dist', join(f.directory, 'dist'), { recursive: true });
    symlinkSync(resolve('node_modules'), join(f.directory, 'node_modules'), 'dir');
    const run = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `globalThis.fetch=()=>{throw Error('network');};globalThis.setTimeout=()=>{throw Error('timer');};globalThis.setInterval=()=>{throw Error('timer');};const core=await import('./dist/core/index.js');if(typeof core.createMessageRouter!=='function'||typeof core.createPublicationService!=='function')throw Error('missing');`,
      ],
      { cwd: f.directory, encoding: 'utf8', timeout: 10000 },
    );
    expect(run.status, run.stderr).toBe(0);
  } finally {
    f.cleanup();
  }
});
