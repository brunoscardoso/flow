// App-workspace Jest config — CommonJS ts-jest (the main process is CJS
// TypeScript), launched via scripts/run-jest.mjs under Electron-as-Node so
// the Electron-ABI better-sqlite3 binary loads. The ROOT package has its own
// independent ESM Jest setup (jest.config.cjs at the repo root, roots:
// ['<rootDir>/src']) — the two suites never see each other's tests.
/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.test.json',
        // Type errors fail the test run — the ipc-contract exhaustiveness
        // test relies on this to turn compile-level drift into a red test.
        diagnostics: true,
      },
    ],
    // shared/*.mjs is plain ESM on purpose (the packaging scripts and the main
    // process must import the same file); Jest runs as CommonJS here, and
    // ts-jest cannot downlevel a `.mjs` — the transformer explains why.
    '^.+\\.mjs$': '<rootDir>/scripts/jest-mjs-transform.cjs',
  },
  moduleNameMapper: {
    '^@shared/(.*)$': '<rootDir>/src/shared/$1',
  },
  testTimeout: 15000,
  // Every test runs with a Flow folder that does not exist — never ~/plan-flow.
  setupFiles: ['<rootDir>/jest.setup.cjs'],
}
