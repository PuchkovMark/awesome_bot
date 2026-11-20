import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from 'vitest';

test('Node.js загружает пять собранных ESM-слоёв без запуска приложения', () => {
  const modules = ['core', 'channels', 'tools', 'storage', 'llm'].map(
    (layer) => pathToFileURL(resolve('dist', layer, 'index.js')).href,
  );
  const output = execFileSync(process.execPath, [
    '--input-type=module',
    '--eval',
    `await Promise.all(${JSON.stringify(modules)}.map(url => import(url)));`,
  ], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  expect(output).toBe('');
  expect(readdirSync('dist').sort()).toEqual(['channels', 'core', 'llm', 'storage', 'tools']);
});
