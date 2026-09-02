// Minimal Jest config for the AI unit specs, under Node 22.
//
// `npm test` cannot run in this fork at all (see docs/agents/ticket-workflow.md, "Known gap:
// the test harness"): under Node 24, jest.config.ts is read as native ESM and dies on its
// extensionless import; even under Node 22, setupFilesAfterEnv -> test/helpers/setup.ts pulls
// in @ee/audit-logs/module, and server/ee/ is an empty, uncloned submodule in this CE-only
// fork. Only the test/modules/ai/unit specs are pure enough to run without that setup chain.
//
// This mirrors jest.config.ts's rootDir, moduleNameMapper (including the mariadb and
// test-helper mocks) and ts-jest transform, and drops globalSetup, setupFiles,
// setupFilesAfterEnv, runner: 'groups' and coverageConfig.
//
// Two things this file alone doesn't cover, both required to actually run it:
//   - `plugins/dist` (and each `plugins/packages/*/dist`) must be built — importing
//     src/modules/ai/service.ts pulls in the data-sources module, which requires
//     @tooljet/plugins/dist/server eagerly. Run the repo-root build, or symlink an
//     already-built plugins/dist from another checkout, before running this config.
//   - TOOLJET_DB / TOOLJET_DB_USER / TOOLJET_DB_HOST / TOOLJET_DB_PASS must be set in the
//     environment (ormconfig.ts validates them at import time, same import chain as above).
//     Use your local Postgres values — nothing here needs a real connection to open, the
//     module just needs the config object to build without throwing.
module.exports = {
  verbose: true,
  moduleFileExtensions: ['js', 'json', 'ts', 'node'],
  rootDir: '.',
  testEnvironment: 'node',
  testRegex: 'test/modules/ai/unit/.*spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': [
      'ts-jest',
      {
        tsconfig: 'tsconfig.json',
        diagnostics: false,
      },
    ],
  },
  moduleNameMapper: {
    '^ormconfig$': '<rootDir>/ormconfig.ts',
    '^src/(.*)': '<rootDir>/src/$1',
    '^scripts/(.*)': '<rootDir>/scripts/$1',
    '^lib/(.*)': '<rootDir>/lib/$1',
    '@dto/(.*)': '<rootDir>/src/dto/$1',
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
    '^test-helper$': '<rootDir>/test/test.helper.ts',
  },
  testTimeout: 30000,
  modulePathIgnorePatterns: ['<rootDir>/dist/'],
  transformIgnorePatterns: ['node_modules/(?!(@octokit|before-after-hook|universal-user-agent|is-plain-object)/)'],
};
