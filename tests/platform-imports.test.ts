import { ESLint } from 'eslint';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

const ruleId = 'boundaries/platform-imports';
const eslint = new ESLint({ cwd: resolve('.') });
const forbidden = [
  "import { VK } from 'vk-io';",
  "import 'vk-io';",
  "import { VK } from 'vk-io/lib';",
  "import type { VK } from 'vk-io';",
  "export { VK } from 'vk-io';",
  "export type { VK } from 'vk-io';",
  "export * from 'vk-io';",
  "type VK = import('vk-io').VK;",
  "import VK = require('vk-io');",
  "void import('vk-io');",
  'void import(`vk-io/lib`);',
  "require('vk-io');",
  "void import(packageName);",
  "require(packageName);",
  'void import(`vk-${platform}`);',
];

for (const layer of ['core', 'tools', 'contracts']) {
  test.each(forbidden)(`${layer}: отклоняется %s`, async (code) => {
    const results = await eslint.lintText(code, { filePath: `src/${layer}/nested/example.ts` });
    const messages = results.flatMap((result) => result.messages);
    expect(messages.some((message) => message.fatal)).toBe(false);
    expect(messages.filter((message) => message.ruleId === ruleId)).toHaveLength(1);
  });

  test.each([
    "import './neutral';",
    "import 'node:fs';",
    "import 'vk-io-extra';",
    "void import('node:fs');",
    "require('node:fs');",
  ])(`${layer}: разрешается %s`, async (code) => {
    const results = await eslint.lintText(code, { filePath: `src/${layer}/example.ts` });
    const messages = results.flatMap((result) => result.messages);
    expect(messages.some((message) => message.fatal)).toBe(false);
    expect(messages.filter((message) => message.ruleId === ruleId)).toEqual([]);
  });
}

test('адаптер может импортировать платформенную библиотеку', async () => {
  const results = await eslint.lintText("import 'vk-io';", { filePath: 'src/channels/vk/example.ts' });
  expect(results.flatMap((result) => result.messages)).toEqual([]);
});

test('список расширяется без установки нового SDK', async () => {
  const extended = new ESLint({
    cwd: resolve('.'),
    overrideConfig: [{
      files: ['src/core/**/*.ts'],
      rules: { [ruleId]: ['error', { packages: ['vk-io', 'example-platform-sdk'] }] },
    }],
  });
  const results = await extended.lintText("import 'example-platform-sdk/api';", { filePath: 'src/core/example.ts' });
  expect(results.flatMap((result) => result.messages).map((message) => message.ruleId)).toEqual([ruleId]);
});
