import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * One flat config for the whole workspace.
 *
 * Type-aware linting is deliberately off. `tsc --noEmit` already runs over
 * every package in CI and catches the type errors; turning on the type-aware
 * rule set would mean a second full type-check for a handful of extra rules.
 * What is left is the class of mistake the compiler is happy with: an unused
 * import, a floating promise's cousin `no-unused-expressions`, a `catch` that
 * swallows, a `console.log` left in a request path.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.d.ts',
      'apps/api/src/generated/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      // The compiler reports unused locals; ESLint adds the leading-underscore
      // escape hatch for arguments a signature must keep but a body ignores.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      // `any` is a decision, not an accident: it has to be written down.
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      // Prettier owns line breaks. It formats a computed member access on a
      // chain (`.http()` then `[method](...)`) across two lines, which this
      // rule reads as an ASI hazard it is not.
      'no-unexpected-multiline': 'off',
    },
  },

  // Seeds, scripts and workers are command-line programs: printing is the point.
  {
    files: ['**/prisma/seed.ts', '**/src/worker.ts', '**/*.config.{ts,js,mjs}', 'e2e/**/*.ts'],
    rules: { 'no-console': 'off' },
  },

  // Tests reach past the public shape of things on purpose.
  {
    files: ['**/test/**/*.ts', '**/*.test.ts', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
