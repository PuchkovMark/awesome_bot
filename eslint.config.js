import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import importX from 'eslint-plugin-import-x';
import jest from 'eslint-plugin-jest';
import promise from 'eslint-plugin-promise';
import security from 'eslint-plugin-security';
import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'logs/**',
      'dev_data/**',
      'prisma/migrations/**',
    ],
  },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      promise.configs['flat/recommended'],
      importX.configs['flat/recommended'],
      importX.configs['flat/typescript'],
      security.configs.recommended,
      sonarjs.configs.recommended,
      unicorn.configs.unopinionated,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: globals.node,
    },
    rules: {
      // JavaScript: дополнительные жёсткие правила
      curly: ['error', 'all'],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'error',
      'no-duplicate-imports': ['error', { allowSeparateTypeImports: true }],
      'no-else-return': ['error', { allowElseIf: false }],
      'no-implicit-coercion': 'error',
      'no-param-reassign': ['error', { props: false }],
      'no-return-assign': 'error',
      'no-throw-literal': 'error',
      'no-unneeded-ternary': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      'prefer-template': 'error',
      radix: 'error',

      // TypeScript: явные и безопасные типы
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          ignoreVoid: true,
          allowForKnownSafeCalls: [
            { from: 'package', name: ['describe', 'it', 'test'], package: 'node:test' },
          ],
        },
      ],
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-require-imports': 'error',
      // Правило даёт ложные срабатывания на изменяемом состоянии внутри callback'ов.
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-unnecessary-type-conversion': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrors: 'none', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowBoolean: true, allowNumber: true },
      ],
      '@typescript-eslint/return-await': 'off',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',

      // Security: шумные эвристики отключены, остальные правила включены как ошибки.
      'security/detect-object-injection': 'off',
      // Пересекается с sonarjs/slow-regex и даёт ложные срабатывания на сложных,
      // но ограниченных регулярных выражениях проекта.
      'security/detect-unsafe-regex': 'off',
      'security/detect-buffer-noassert': 'error',
      'security/detect-bidi-characters': 'error',
      'security/detect-child-process': 'error',
      'security/detect-disable-mustache-escape': 'error',
      'security/detect-eval-with-expression': 'error',
      'security/detect-invisible-characters': 'error',
      'security/detect-new-buffer': 'error',
      'security/detect-non-literal-fs-filename': 'error',
      'security/detect-non-literal-regexp': 'error',
      'security/detect-non-literal-require': 'error',
      'security/detect-possible-timing-attacks': 'error',
      'security/detect-pseudoRandomBytes': 'error',

      // Import-X: CJS-совместимость и отдельные type-импорты дают ложные срабатывания.
      'import-x/no-named-as-default': 'off',
      'import-x/no-named-as-default-member': 'off',
      'import-x/no-duplicates': 'off',

      // SonarJS: оставляем правила поиска дефектов, отключаем шумные стилевые проверки.
      'sonarjs/cognitive-complexity': ['error', 200],
      'sonarjs/concise-regex': 'off',
      'sonarjs/max-switch-cases': 'off',
      'sonarjs/no-nested-conditional': 'off',
      'sonarjs/no-nested-functions': 'off',
      'sonarjs/no-nested-template-literals': 'off',
      'sonarjs/prefer-regexp-exec': 'off',
      'sonarjs/pseudo-random': 'off',
      'sonarjs/regex-complexity': 'off',
      'sonarjs/single-character-alternation': 'off',
      'sonarjs/super-linear-regex': 'off',

      // Unicorn: оставляем правила, которые ловят ошибки, но отключаем
      // слишком субъективные переписывания существующего кода.
      'unicorn/no-array-reverse': 'off',
      'unicorn/no-array-sort': 'off',
      'unicorn/consistent-existence-index-check': 'off',
      'unicorn/no-declarations-before-early-exit': 'off',
      'unicorn/no-for-each': 'off',
      'unicorn/no-lonely-if': 'off',
      'unicorn/no-negated-array-predicate': 'off',
      'unicorn/no-negated-condition': 'off',
      'unicorn/no-process-exit': 'off',
      'unicorn/no-unreadable-array-destructuring': 'off',
      'unicorn/no-useless-coercion': 'off',
      'unicorn/numeric-separators-style': 'off',
      'unicorn/prefer-array-some': 'off',
      'unicorn/prefer-boolean-return': 'off',
      'unicorn/prefer-code-point': 'off',
      'unicorn/prefer-await': 'off',
      'unicorn/prefer-default-parameters': 'off',
      'unicorn/prefer-early-return': 'off',
      'unicorn/prefer-global-number-constants': 'off',
      'unicorn/prefer-logical-operator-over-ternary': 'off',
      'unicorn/prefer-minimal-ternary': 'off',
      'unicorn/prefer-promise-with-resolvers': 'off',
      'unicorn/prefer-split-limit': 'off',
      'unicorn/prefer-string-raw': 'off',
      'unicorn/prefer-switch': 'off',
      'unicorn/prefer-ternary': 'off',
      'unicorn/prefer-unicode-code-point-escapes': 'off',
      'unicorn/prefer-url-href': 'off',
    },
  },
  {
    files: ['test/**/*.ts'],
    extends: [jest.configs['flat/recommended']],
    rules: {
      // Тесты используют node:test и assert, а не expect из Jest.
      'jest/expect-expect': ['error', { assertFunctionNames: ['assert.*'] }],
      // В проекте нет Jest, поэтому проверять устаревшие функции нечего.
      'jest/no-deprecated-functions': 'off',
      // В тестах неизбежны моки и JSON.parse с типом any.
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
  prettier,
);
