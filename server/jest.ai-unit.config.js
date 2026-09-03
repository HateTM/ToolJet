// Minimal Jest config for the AI unit specs, under Node 22.
//
// `npm test` cannot run in this fork at all (see docs/agents/ticket-workflow.md, "Known gap:
// the test harness"): under Node 24, jest.config.ts is read as native ESM and dies on its
// extensionless import; even under Node 22, setupFilesAfterEnv -> test/helpers/setup.ts pulls
// in @ee/audit-logs/module, and server/ee/ is an empty, uncloned submodule in this CE-only
// fork. Only the test/modules/ai/unit specs and the mocked tooljet-db create-table spec
// are pure enough to run without that setup chain.
//
// This mirrors jest.config.ts's rootDir, moduleNameMapper (including the mariadb and
// test-helper mocks) and ts-jest transform, and drops globalSetup, setupFiles,
// setupFilesAfterEnv, runner: 'groups' and coverageConfig.
//
// One thing this file alone doesn't cover, required to actually run it:
//   - TOOLJET_DB / TOOLJET_DB_USER / TOOLJET_DB_HOST / TOOLJET_DB_PASS must be set in the
//     environment (ormconfig.ts validates them at import time, same import chain as above).
//     Use your local Postgres values — nothing here needs a real connection to open, the
//     module just needs the config object to build without throwing.
//
// The @tooljet/plugins barrel, isolated-vm and got are mapped to offline mocks (ported
// verbatim from the deleted jest-ai-unit.config.ts): the plugins monorepo build is broken
// here, isolated-vm v5's native binding is compiled against a different Node version, and
// got v14 is ESM-only. The specs under this config never exercise their real behavior.
module.exports = {
  verbose: true,
  moduleFileExtensions: ['js', 'json', 'ts', 'node'],
  rootDir: '.',
  testEnvironment: 'node',
  testRegex:
    'test/modules/ai/unit/.*spec\\.ts$|test/modules/tooljet-db/unit/tooljet-db-create-table.*spec\\.ts$',
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
    '@dto/(.*)': '<rootDir>/src/dto/$1',
    // Point @tooljet/plugins at an offline stub — the real barrel imports all 47
    // data-source packages and the plugins monorepo build is broken in this
    // environment, so dist/server.js is never emitted. Ported verbatim from
    // jest-ai-unit.config.ts; the specs here only need the re-exported errors.
    '^@tooljet/plugins/dist/server$': '<rootDir>/test/__mock__/plugins-server.ts',
    '^@tooljet/plugins$': '<rootDir>/test/__mock__/plugins-server.ts',
    '@plugins/(.*)': '<rootDir>/plugins/$1',
    '@services/(.*)': '<rootDir>/src/services/$1',
    '@entities/(.*)': '<rootDir>/src/entities/$1',
    '@controllers/(.*)': '<rootDir>/src/controllers/$1',
    '@modules/(.*)': '<rootDir>/src/modules/$1',
    '^@ee/audit-logs/module$': '<rootDir>/test/__mocks__/ee/audit-logs/module.ts',
    '^@ee/licensing/constants/PlanTerms$': '<rootDir>/test/__mocks__/ee/licensing/constants/PlanTerms.ts',
    '@ee/(.*)': '<rootDir>/ee/$1',
    '@apps/(.*)': '<rootDir>/ee/apps/$1',
    '@helpers/(.*)': '<rootDir>/src/helpers/$1',
    '@licensing/(.*)': '<rootDir>/ee/licensing/$1',
    '@instance-settings/(.*)': '<rootDir>/ee/instance-settings/$1',
    '@otel/(.*)': '<rootDir>/src/otel/$1',
    '^mariadb$': '<rootDir>/test/__mocks__/mariadb.ts',
    // isolated-vm (v5) ships a native binding that fails to build on this env's
    // Node 24; the AI Builder specs never run the RunJS data-source runtime.
    // got v14 is ESM-only and cannot be require()d under jest. Both mocks are
    // ported verbatim from jest-ai-unit.config.ts.
    '^isolated-vm$': '<rootDir>/test/__mock__/isolated-vm.ts',
    '^got$': '<rootDir>/test/__mock__/got.ts',
    '^test-helper$': '<rootDir>/test/test.helper.ts',
  },
  testTimeout: 30000,
  modulePathIgnorePatterns: ['<rootDir>/dist/'],
  transformIgnorePatterns: [
    'node_modules/(?!(@octokit|before-after-hook|universal-user-agent|is-plain-object|ai|@ai-sdk|@workflow|@standard-schema)/)',
  ],
};
