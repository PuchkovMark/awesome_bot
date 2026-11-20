import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createSkeletonFixture } from './helpers/skeleton-fixture.js';

let fixture: ReturnType<typeof createSkeletonFixture>;

beforeAll(() => { fixture = createSkeletonFixture(); });
afterAll(() => { fixture?.cleanup(); });

function build() {
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error('Запускайте тесты через npm test, чтобы определить используемый npm.');
  const result = spawnSync(process.execPath, [npm, 'run', 'build'], {
    cwd: fixture.directory,
    env: process.env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  expect(result.signal).toBeNull();
  return { status: result.status, output: result.stdout + result.stderr };
}

test('корректный проект собирается без сетевой установки', () => {
  const result = build();
  expect(result.output).not.toContain('boundaries/platform-imports');
  expect(result.status, result.output).toBe(0);
  expect(existsSync(join(fixture.directory, 'dist/core/index.js'))).toBe(true);
}, 40_000);

for (const layer of ['core', 'tools']) {
  test.each([
    "import 'vk-io';",
    "import type { VK } from 'vk-io'; export type Example = VK;",
  ])(`сборка блокирует ${layer}: %s`, (code) => {
    const directory = join(fixture.directory, 'src', layer, 'nested');
    mkdirSync(directory, { recursive: true });
    const path = join(directory, 'forbidden.ts');
    // Исключить влияние уже выпущенных артефактов положительного сценария.
    rmSync(join(fixture.directory, 'dist'), { recursive: true, force: true });
    writeFileSync(path, code);
    try {
      const result = build();
      expect(result.status).not.toBe(0);
      expect(result.output).toContain('boundaries/platform-imports');
      expect(result.output).not.toContain('> tsc --noEmit');
      expect(existsSync(join(fixture.directory, 'dist'))).toBe(false);
    } finally {
      rmSync(path);
    }
  }, 40_000);
}
