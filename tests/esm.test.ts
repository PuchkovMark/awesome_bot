import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from 'vitest';

test('Node.js загружает собранные ESM-модули без запуска приложения', () => {
  const modules = ['core', 'channels', 'tools', 'storage', 'llm', 'config', 'logger', 'contracts'].map(
    (layer) => pathToFileURL(resolve('dist', layer, 'index.js')).href,
  );
  const directory = mkdtempSync(join(tmpdir(), 'awesome-import-'));
  try {
    const script = `
      const { syncBuiltinESMExports } = await import('node:module');
      const fs = (await import('node:fs')).default;
      const original = fs.readFileSync;
      fs.readFileSync = function(path, ...args) {
        if (String(path).endsWith('.env')) throw new Error('Configuration read during import');
        return original.call(this, path, ...args);
      };
      syncBuiltinESMExports();
      const before = JSON.stringify(process.env);
      await Promise.all(${JSON.stringify(modules)}.map(url => import(url)));
      if (before !== JSON.stringify(process.env)) throw new Error('Environment changed during import');
      process.stdout.write('IMPORT_COMPLETED');
    `;
    const output = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: directory, encoding: 'utf8', env: {}, timeout: 10_000,
    });
    expect(output.error).toBeUndefined();
    expect(output.status, output.stderr).toBe(0);
    expect(output.signal).toBeNull();
    expect(output.stdout).toBe('IMPORT_COMPLETED');
    expect(output.stderr).toBe('');
    expect(readdirSync(directory)).toEqual([]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
  expect(readdirSync('dist').sort()).toEqual(['channels', 'config', 'contracts', 'core', 'llm', 'logger', 'storage', 'tools']);
});
