import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import platformImports from './scripts/eslint/platform-imports.mjs';

// Дополнять при подключении новой платформенной библиотеки.
const platformPackages = ['vk-io'];

export default tseslint.config(
  { ignores: ['node_modules/**', 'dist/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/{core,tools}/**/*.{ts,mts,cts}'],
    plugins: { boundaries: { rules: { 'platform-imports': platformImports } } },
    rules: { 'boundaries/platform-imports': ['error', { packages: platformPackages }] },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
);
