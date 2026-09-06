import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import pluginJest from 'eslint-plugin-jest';
import pluginPrettier from 'eslint-plugin-prettier';
import configPrettier from 'eslint-config-prettier';
import globals from 'globals';

// Flat-config port of the legacy .eslintrc.js (rules preserved except:
// interface-name-prefix (removed upstream long ago) and ban-types (removed
// in @typescript-eslint v8) are dropped).
export default [
  {
    ignores: [
    // Ported from the legacy .eslintignore
    'dist/**',
    '.eslintignore',
    'packages/*/__tests__/**/*.js',
    'packages/*/dist/**',
    'client.js',
    'server.ts',
    'node_modules/**',
  ],
  },
  {
    // Plain-JS helper scripts live outside tsconfig.json — no typed parsing.
    files: ['**/*.js'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'commonjs',
      },
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      jest: pluginJest,
      prettier: pluginPrettier,
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': 'off',
      'prettier/prettier': [
        'error',
        {
          semi: true,
          trailingComma: 'es5',
          printWidth: 120,
          singleQuote: true,
        },
      ],
      '@typescript-eslint/no-var-requires': 'off',
    },
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      jest: pluginJest,
      prettier: pluginPrettier,
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': 'off',
      'prettier/prettier': [
        'error',
        {
          semi: true,
          trailingComma: 'es5',
          printWidth: 120,
          singleQuote: true,
        },
      ],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { vars: 'all', args: 'none' }],
      '@typescript-eslint/no-var-requires': 'off',
      '@typescript-eslint/no-empty-function': 'off',
    },
  },
  {
    files: ['**/*.spec.ts', '**/*.test.ts'],
    rules: {
      ...configPrettier.rules,
    },
  },
];
