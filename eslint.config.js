import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          // `const { dropped: _x, ...rest } = obj` is the idiom for omitting a
          // key; the binding is meant to be unused.
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // The whole point of src/core is that it holds no I/O and knows no provider.
    // Enforced as an executable rule in test/architecture.test.ts; this mirrors
    // it in the editor so violations surface before the test run.
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: 'src/core must stay free of I/O (AD-03).' },
            { group: ['**/adapters/**'], message: 'src/core must not depend on adapters (AD-03).' },
          ],
        },
      ],
    },
  },
  {
    // The dashboard is a separate workspace with its own compiler, so its files
    // are not in the CLI's `tsconfig` project. Linted without type information
    // rather than not linted at all: unused variables, unreachable code and bad
    // imports are worth catching in fifteen new files, and `tsc --noEmit` in the
    // web build covers what needs types.
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: { projectService: false, project: false },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'apps/web/dist/**',
      'apps/web/node_modules/**',
    ],
  },
);
