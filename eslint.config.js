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
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
);
