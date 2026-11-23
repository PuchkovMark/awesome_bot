import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createSkeletonFixture } from './helpers/skeleton-fixture';

let fixture: ReturnType<typeof createSkeletonFixture>;
const buildTimeoutMs = 60_000;
const testTimeoutMs = buildTimeoutMs + 20_000;

beforeAll(() => {
  fixture = createSkeletonFixture();
});
afterAll(() => {
  fixture?.cleanup();
});

function build() {
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error('Запускайте тесты через npm test, чтобы определить используемый npm.');
  const result = spawnSync(process.execPath, [npm, 'run', 'build'], {
    cwd: fixture.directory,
    env: process.env,
    encoding: 'utf8',
    timeout: buildTimeoutMs,
  });
  if (result.error) throw result.error;
  expect(result.signal).toBeNull();
  return { status: result.status, output: result.stdout + result.stderr };
}

test(
  'корректный проект собирается без сетевой установки',
  () => {
    writeFileSync(
      join(fixture.directory, 'src/esm-probe.ts'),
      [
        "import { createRedactor } from './config/secrets';",
        "import type { Redact } from './config';",
        "export { ConfigError } from './config';",
        "export const redact: Redact = createRedactor(['secret']);",
        "export const load = () => import('./config/secrets');",
        'export const loadTemplate = () => import(`./config/secrets`);',
        'export const example = "import \'./config/secrets\'";',
        '',
      ].join('\n'),
    );
    const result = build();
    expect(result.output).not.toContain('boundaries/platform-imports');
    expect(result.status, result.output).toBe(0);
    expect(existsSync(join(fixture.directory, 'dist/core/index.js'))).toBe(true);

    const output = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
    import assert from 'node:assert/strict';
    import * as probe from './dist/esm-probe.js';
    assert.equal(probe.redact('secret'), '[REDACTED]');
    assert.equal(probe.ConfigError.name, 'ConfigError');
    assert.equal(await probe.load(), await probe.loadTemplate());
    assert.equal(probe.example, "import './config/secrets'");
  `,
      ],
      { cwd: fixture.directory, env: {}, encoding: 'utf8', timeout: 10_000 },
    );
    expect(output.error).toBeUndefined();
    expect(output.status, output.stderr).toBe(0);
  },
  testTimeoutMs,
);

for (const layer of ['core', 'tools']) {
  test.each(["import 'vk-io';", "import type { VK } from 'vk-io';\nexport type Example = VK;"])(
    `сборка блокирует ${layer}: %s`,
    (code) => {
      const directory = join(fixture.directory, 'src', layer, 'nested');
      mkdirSync(directory, { recursive: true });
      const path = join(directory, 'forbidden.ts');
      // Исключить влияние уже выпущенных артефактов положительного сценария.
      rmSync(join(fixture.directory, 'dist'), { recursive: true, force: true });
      writeFileSync(path, code + '\n');
      try {
        const result = build();
        expect(result.status).not.toBe(0);
        expect(result.output).toContain('boundaries/platform-imports');
        expect(result.output).not.toContain('> tsc --noEmit');
        expect(existsSync(join(fixture.directory, 'dist'))).toBe(false);
      } finally {
        rmSync(path);
      }
    },
    testTimeoutMs,
  );
}
