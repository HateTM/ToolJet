/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/test/**/*.test.ts'],
  // `ai`/`@ai-sdk/*` ship ESM-only (no CJS export) — transform their .js
  // through babel so this CJS/ts-jest test setup can still require() them.
  transformIgnorePatterns: ['/node_modules/(?!(ai|@ai-sdk|@workflow|@standard-schema)/)'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
    '^.+\\.jsx?$': ['babel-jest', { presets: [['@babel/preset-env', { targets: { node: 'current' } }]] }],
  },
};
