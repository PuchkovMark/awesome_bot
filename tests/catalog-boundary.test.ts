import { mkdirSync, writeFileSync, cpSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';
import { checkCatalogBoundary } from '../scripts/check-catalog-boundary.mjs';
import { storageFixture } from './helpers/storage-fixture';
function fixture() {
  const f = storageFixture();
  const put = (p: string, text: string) => {
    mkdirSync(join(f.directory, p, '..'), { recursive: true });
    writeFileSync(join(f.directory, p), text);
  };
  put(
    'tsconfig.json',
    JSON.stringify({
      compilerOptions: {
        module: 'ESNext',
        moduleResolution: 'Bundler',
        paths: { '@catalog': ['./src/storage/catalog-admin.ts'] },
      },
      include: ['src/**/*.ts'],
    }),
  );
  put('src/storage/catalog-admin.ts', 'export const admin=1;');
  symlinkSync(resolve('node_modules'), join(f.directory, 'node_modules'), 'dir');
  return { ...f, put };
}
test.each([
  "import '../storage/catalog-admin';",
  "export * from '../storage/catalog-admin';",
  "import type {A} from '../storage/catalog-admin';",
  "type A=import('../storage/catalog-admin').A;",
  "import A=require('../storage/catalog-admin');",
  "void import('../storage/catalog-admin');",
  "require('../storage/catalog-admin');",
  "import '@catalog';",
  'void import(target);',
])('граф отклоняет доступ %s', (code) => {
  const f = fixture();
  try {
    f.put('src/core/context.ts', "import '../helper';");
    f.put('src/helper.ts', "export * from './bridge';");
    f.put('src/bridge.ts', code.replaceAll('../storage/', './storage/'));
    expect(checkCatalogBoundary(f.directory)).toEqual([
      code === 'void import(target);'
        ? 'src/core/context.ts: catalog_boundary: uncheckable_import'
        : 'src/core/context.ts: catalog_boundary: forbidden_access',
    ]);
  } finally {
    f.cleanup();
  }
});
test('все корни защищены; запросный reader и композиция разрешены', () => {
  const f = fixture();
  try {
    for (const root of [
      'tools/a.ts',
      'commands/a.ts',
      'core/commands/a.ts',
      'context/a.ts',
      'core/context/a.ts',
      'core/context.ts',
    ]) {
      f.put('src/' + root, "import '@catalog';");
    }
    expect(checkCatalogBoundary(f.directory)).toHaveLength(6);
  } finally {
    f.cleanup();
  }
  const good = fixture();
  try {
    good.put('src/tools/a.ts', "import '../storage/index';");
    good.put('src/storage/index.ts', 'export const reader=1;');
    good.put('src/main.ts', "import '@catalog';");
    expect(checkCatalogBoundary(good.directory)).toEqual([]);
  } finally {
    good.cleanup();
  }
});
test('проверка графа останавливает команду сборки', () => {
  const f = fixture();
  try {
    f.put('src/tools/a.ts', "import '@catalog';");
    cpSync('scripts/check-catalog-boundary.mjs', join(f.directory, 'check.mjs'));
    const build = JSON.parse(requirePackage()).scripts.build as string;
    const checkIndex = build.indexOf('npm run check:catalog');
    expect(checkIndex).toBeGreaterThan(0);
    expect(checkIndex).toBeLessThan(build.indexOf('npm run typecheck'));
    f.put(
      'package.json',
      JSON.stringify({
        type: 'module',
        scripts: {
          build,
          lint: 'node -e ""',
          'check:catalog': 'node check.mjs',
          typecheck: 'node -e "process.stdout.write(\'UNREACHABLE\')"',
        },
      }),
    );
    const result = spawnSync('npm', ['run', 'build'], {
      cwd: f.directory,
      encoding: 'utf8',
      timeout: 15000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('catalog_boundary');
    expect(result.stdout).not.toContain('UNREACHABLE');
  } finally {
    f.cleanup();
  }
});
function requirePackage() {
  return readFileSync('package.json', 'utf8');
}
import { readFileSync } from 'node:fs';

test.each([
  "import {versionBackend as get} from './storage/version-registry';",
  "export {versionBackend as get} from './storage/version-registry';",
  "export * from './storage/version-registry';",
  "import * as registry from './storage/version-registry';",
  "void import('./storage/version-registry');",
  "require('./storage/version-registry');",
  "import {registerVersions} from './storage/version-registry';",
])('внутренний реестр не даёт обход: %s', (code) => {
  const f = fixture();
  try {
    f.put('src/storage/version-registry.ts', 'export const versionBackend=1,registerVersions=1;');
    f.put('src/helper.ts', code);
    f.put('src/tools/a.ts', "import '../helper';");
    expect(checkCatalogBoundary(f.directory)).toHaveLength(1);
  } finally {
    f.cleanup();
  }
});
test('единственное исключение реестра — регистрация из открытия Storage', () => {
  const f = fixture();
  try {
    f.put('src/storage/version-registry.ts', 'export const versionBackend=1,registerVersions=1;');
    f.put('src/storage/storage.ts', "import {registerVersions} from './version-registry';");
    f.put('src/storage/index.ts', "import './storage';");
    f.put('src/tools/a.ts', "import '../storage/index';");
    expect(checkCatalogBoundary(f.directory)).toEqual([]);
    f.put(
      'src/storage/storage.ts',
      "import {registerVersions,versionBackend} from './version-registry';",
    );
    expect(checkCatalogBoundary(f.directory)).toHaveLength(1);
  } finally {
    f.cleanup();
  }
});

test.each([
  'queue-registry.ts',
  'queue-store.ts',
  'token-budget-store.ts',
  'lifecycle-store.ts',
  'autonomous-questions.ts',
  'reminder-store.ts',
  'participant-registry.ts',
])('инфраструктура %s недоступна через транзитивный импорт', (module) => {
  const f = fixture();
  try {
    f.put('src/storage/' + module, 'export const admin=1;');
    f.put('src/helper.ts', `export * from './storage/${module.replace(/\.ts$/, '')}';`);
    f.put('src/core/context.ts', "import '../helper';");
    expect(checkCatalogBoundary(f.directory)).toHaveLength(1);
  } finally {
    f.cleanup();
  }
});

test('чтение через Storage не делает сервис решений владельца доступным инструментам', () => {
  const f = fixture();
  try {
    f.put(
      'src/storage/lifecycle-store.ts',
      'export const createLifecycleBackend=1,registerLifecycle=1,lifecycleBackend=1,installAuthorities=1;',
    );
    f.put(
      'src/storage/storage.ts',
      "import {createLifecycleBackend,registerLifecycle} from './lifecycle-store'; import './chats';",
    );
    f.put('src/storage/chats.ts', "import {installAuthorities} from './lifecycle-store';");
    f.put('src/tools/a.ts', "import '../storage/storage';");
    expect(checkCatalogBoundary(f.directory)).toEqual([]);
    f.put(
      'src/core/lifecycle/service.ts',
      "import {lifecycleBackend} from '../../storage/lifecycle-store';",
    );
    f.put('src/tools/a.ts', "import '../core/lifecycle/service';");
    expect(checkCatalogBoundary(f.directory)).toHaveLength(1);
  } finally {
    f.cleanup();
  }
});
