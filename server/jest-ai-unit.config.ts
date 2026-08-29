import type { Config } from '@jest/types';

// Minimal override of jest.config.ts for offline AI Builder unit tests.
// Drops the DB-backed global setup and transaction setup so the specs can run
// without a Postgres/Redis stack; ts-jest transpiles TS in --transpile-only mode.
const config: Config.InitialOptions = {
  verbose: true,
  moduleFileExtensions: ['js', 'json', 'ts', 'node'],
  rootDir: '.',
  testEnvironment: 'node',
  globalSetup: undefined,
  setupFiles: [],
  setupFilesAfterEnv: [],
  testRegex: 'test/modules/ai/unit/.*spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': [
      'ts-jest',
      {
        tsconfig: 'tsconfig.json',
        diagnostics: false,
        isolatedModules: true,
      },
    ],
  },
  moduleNameMapper: {
    '^ormconfig$': '<rootDir>/ormconfig.ts',
    '^src/(.*)': '<rootDir>/src/$1',
    '^scripts/(.*)': '<rootDir>/scripts/$1',
    '^lib/(.*)': '<rootDir>/lib/$1',
    // Point @tooljet/plugins at its TS source — the plugins monorepo build
    // (create:server) is broken in this environment, so dist/server.js is never
    // emitted. The AI Builder unit specs only need QueryError + the plugins list.
    '^@tooljet/plugins/dist/server$': '<rootDir>/test/__mock__/plugins-server.ts',
    '^@tooljet/plugins$': '<rootDir>/test/__mock__/plugins-server.ts',
    '^@plugins/(.*)': '<rootDir>/plugins/$1',
    '@services/(.*)': '<rootDir>/src/services/$1',
    '@entities/(.*)': '<rootDir>/src/entities/$1',
    '@controllers/(.*)': '<rootDir>/src/controllers/$1',
    '@modules/(.*)': '<rootDir>/src/modules/$1',
    '@ee/(.*)': '<rootDir>/ee/$1',
    '@apps/(.*)': '<rootDir>/ee/apps/$1',
    '@helpers/(.*)': '<rootDir>/src/helpers/$1',
    '@licensing/(.*)': '<rootDir>/ee/licensing/$1',
    '@instance-settings/(.*)': '<rootDir>/ee/instance-settings/$1',
    '@otel/(.*)': '<rootDir>/src/otel/$1',
    '^mariadb$': '<rootDir>/test/__mocks__/mariadb.ts',
    // isolated-vm (v5) ships a native binding that fails to build on this env's
    // Node 24; the AI Builder specs never run the RunJS data-source runtime.
    '^isolated-vm$': '<rootDir>/test/__mock__/isolated-vm.ts',
    '^got$': '<rootDir>/test/__mock__/got.ts',
    '^test-helper$': '<rootDir>/test/test.helper.ts',
  },
  coverageDirectory: '<rootDir>/coverage-unit',
  runner: 'groups',
  testTimeout: 30000,
  modulePathIgnorePatterns: ['<rootDir>/dist/'],
  transformIgnorePatterns: [
    // Transform the plugins packages (baserow's `got` is ESM-only) and the allowed
    // node_modules packages. The plugins packages are under plugins/packages/<name>/,
    // not under node_modules/.
    'node_modules/(?!(@octokit|before-after-hook|universal-user-agent|is-plain-object|plugins/packages/[^/]+)/)',
  ],
};

export default config;
