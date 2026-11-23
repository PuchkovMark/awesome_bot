import { cpSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export function createSkeletonFixture(): { directory: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'awesome-bot-skeleton-'));
  try {
    for (const path of [
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      'tsconfig.build.json',
      '.gitignore',
      'eslint.config.mjs',
      'vitest.config.ts',
      'vitest.queue-load.config.ts',
      'src',
      'scripts',
      'tests',
    ]) {
      cpSync(resolve(path), join(directory, path), { recursive: true });
    }
    symlinkSync(resolve('node_modules'), join(directory, 'node_modules'), 'dir');
    return { directory, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
