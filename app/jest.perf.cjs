// Perf-probe runner — the same Electron-as-Node setup as the test suite, over
// `perf/*.probe.ts` instead of `src/**/*.test.ts`.
//
// Separate config on purpose: probes build worst cases (a 600-call thread, a
// 3,000-file walk) and take seconds each. In the normal suite they would be
// flake and cost; here they are the point. `npm run perf -w app`.
/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/perf'],
  testMatch: ['**/*.probe.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json', diagnostics: true }],
    '^.+\\.mjs$': '<rootDir>/scripts/jest-mjs-transform.cjs',
  },
  moduleNameMapper: { '^@shared/(.*)$': '<rootDir>/src/shared/$1' },
  // A probe that needs two minutes is a probe measuring something real.
  testTimeout: 300000,
  maxWorkers: 1,
}
